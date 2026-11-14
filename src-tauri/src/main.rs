// Image Viewer — native shell.
//
// The entire UI is the same HTML page the browser build produces. Rust only
// does what a web page cannot: show the open dialog, read the image the user
// picked (and the other images in its folder), receive the file Windows/macOS
// hands us when someone double-clicks an image, and write a "-dark.png" copy.
//
// File access is grant-based. A path becomes readable only when the user
// hands it over: the open dialog (run here, not in the page), a drag-drop
// (seen here before the page hears about it), or the command line / "Open
// with". Granting a file also grants the other images in the same folder, so
// next/previous works. Nothing else on disk is reachable from the page.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::UNIX_EPOCH;

use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

const IMAGE_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/// The file this process was launched with, if any. Taken exactly once by the
/// frontend during boot.
struct InitialFile(Mutex<Option<String>>);

/* ---------- grants ---------- */

#[derive(Default)]
struct GrantSet {
    /// Folders whose images may be read (the opened image's folder).
    dirs: HashSet<String>,
}

struct Grants(Mutex<GrantSet>);

/// The absolute path `raw` names, with `.` and `..` resolved without touching
/// the disk, or None if it is relative.
fn lexical_path(raw: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in Path::new(raw).components() {
        match c {
            Component::Prefix(_) | Component::RootDir => out.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(s) => out.push(s),
        }
    }
    out.is_absolute().then_some(out)
}

/// Comparison key: Windows paths are case-insensitive.
fn path_key(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if cfg!(windows) {
        s.replace('/', "\\").to_lowercase()
    } else {
        s
    }
}

fn is_image_path(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

impl GrantSet {
    /// Grant an image the user handed over, and with it its folder. Returns
    /// the normalised path, or None for something that is not an image path.
    fn grant(&mut self, raw: &str) -> Option<PathBuf> {
        let path = lexical_path(raw)?;
        if !is_image_path(&path) {
            return None;
        }
        let dir = path.parent()?;
        self.dirs.insert(path_key(dir));
        Some(path)
    }

    fn dir_allowed(&self, dir: &Path) -> bool {
        self.dirs.contains(&path_key(dir))
    }

    /// An image in a granted folder. Purely lexical: nothing that fails here
    /// ever reaches the filesystem.
    fn readable(&self, raw: &str) -> Option<PathBuf> {
        let path = lexical_path(raw)?;
        if !is_image_path(&path) {
            return None;
        }
        self.dir_allowed(path.parent()?).then_some(path)
    }
}

fn grant(app: &tauri::AppHandle, raw: &str) -> Option<PathBuf> {
    app.state::<Grants>().0.lock().ok()?.grant(raw)
}

fn readable(grants: &Grants, raw: &str) -> Result<PathBuf, String> {
    grants
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .readable(raw)
        .ok_or_else(|| "that file was not opened in Image Viewer".to_string())
}

/// "shot.png" -> "shot-dark.png", then "shot-dark-2.png", …
fn dark_copy_name(source: &Path, n: u32) -> Option<String> {
    let stem = source.file_stem()?.to_string_lossy();
    Some(if n > 1 {
        format!("{stem}-dark-{n}.png")
    } else {
        format!("{stem}-dark.png")
    })
}

#[cfg(test)]
mod grant_tests {
    use super::*;

    fn root() -> &'static str {
        if cfg!(windows) {
            r"C:\Users\Tim\Pictures"
        } else {
            "/home/tim/Pictures"
        }
    }

    fn join(name: &str) -> String {
        format!("{}{}{}", root(), std::path::MAIN_SEPARATOR, name)
    }

    #[test]
    fn nothing_is_readable_before_a_grant() {
        let g = GrantSet::default();
        assert!(g.readable(&join("a.png")).is_none());
    }

    #[test]
    fn granting_an_image_opens_its_folder_images_only() {
        let mut g = GrantSet::default();
        assert!(g.grant(&join("a.png")).is_some());
        assert!(g.readable(&join("b.JPG")).is_some());
        assert!(g.readable(&join("notes.txt")).is_none());
        assert!(g.readable(&join(&format!("sub{}c.png", std::path::MAIN_SEPARATOR))).is_none());
        // `..` is resolved lexically, so it cannot climb out of the folder.
        assert!(g.readable(&join(&format!("..{}x.png", std::path::MAIN_SEPARATOR))).is_none());
        assert!(g.readable("relative.png").is_none());
    }

    #[test]
    fn non_images_are_never_granted() {
        let mut g = GrantSet::default();
        assert!(g.grant(&join("evil.exe")).is_none());
        assert!(g.readable(&join("a.png")).is_none());
    }

    #[test]
    fn windows_paths_compare_case_insensitively() {
        if !cfg!(windows) {
            return;
        }
        let mut g = GrantSet::default();
        g.grant(r"C:\Users\Tim\Pictures\a.png");
        assert!(g.readable(r"c:\users\tim\pictures\B.PNG").is_some());
        assert!(g.readable(r"c:/users/tim/pictures/b.png").is_some());
    }

    #[test]
    fn dark_copy_names_never_reuse_the_original() {
        let p = Path::new("shot.final.png");
        assert_eq!(dark_copy_name(p, 1).unwrap(), "shot.final-dark.png");
        assert_eq!(dark_copy_name(p, 3).unwrap(), "shot.final-dark-3.png");
        assert_eq!(dark_copy_name(Path::new("photo.jpg"), 1).unwrap(), "photo-dark.png");
    }
}

/* ---------- external opens (second launch, macOS Apple Events) ---------- */

// One worker owns routing and the unclaimed queue. Window creation must not run
// in a synchronous IPC command or window-event callback (WebView2 deadlocks).
struct ExternalOpens(mpsc::Sender<OpenMessage>);

enum OpenMessage {
    Open(Option<String>),
    Ready(String),
    Destroyed(String),
    Claim {
        label: String,
        path: String,
        reply: mpsc::Sender<bool>,
    },
}

struct PendingOpen {
    path: String,
    recipient: Option<String>,
    notified: bool,
}

fn select_recipient<'a>(
    labels: impl IntoIterator<Item = &'a str>,
    unavailable: &HashSet<String>,
) -> Option<&'a str> {
    labels
        .into_iter()
        .filter(|label| {
            !unavailable.contains(*label) && (*label == "main" || label.starts_with("doc-"))
        })
        .min_by_key(|label| (*label != "main", *label))
}

fn external_recipient(
    app: &tauri::AppHandle,
    unavailable: &HashSet<String>,
) -> Option<tauri::WebviewWindow> {
    let mut windows = app.webview_windows();
    let label = select_recipient(windows.keys().map(String::as_str), unavailable)?.to_owned();
    windows.remove(&label)
}

fn revoke_recipient(pending: &mut VecDeque<PendingOpen>, label: &str) {
    for request in pending {
        if request.recipient.as_deref() == Some(label) {
            request.recipient = None;
            request.notified = false;
        }
    }
}

fn claim_pending(pending: &mut VecDeque<PendingOpen>, label: &str, path: &str, live: bool) -> bool {
    let index = pending.iter().position(|request| {
        live && request.recipient.as_deref() == Some(label)
            && request.path == path
            && request.notified
    });
    if let Some(index) = index {
        pending.remove(index);
        true
    } else {
        false
    }
}

fn focus_recipient(window: &tauri::WebviewWindow) {
    if let Err(error) = window.unminimize() {
        eprintln!("could not unminimise external-open recipient: {error}");
    }
    if let Err(error) = window.set_focus() {
        eprintln!("could not focus external-open recipient: {error}");
    }
}

fn route_external_opens(app: tauri::AppHandle, receiver: mpsc::Receiver<OpenMessage>) {
    let mut ready = HashSet::new();
    // Failed labels stay excluded as well as destroyed ones, so a delayed URL
    // or event can never claim a later assignment under a reused label.
    let mut unavailable = HashSet::new();
    let mut pending: VecDeque<PendingOpen> = VecDeque::new();
    let mut next_window = 0_u64;

    while let Ok(message) = receiver.recv() {
        match message {
            OpenMessage::Open(path) => {
                if let Some(path) = path {
                    pending.push_back(PendingOpen {
                        path,
                        recipient: None,
                        notified: false,
                    });
                } else if let Some(window) = external_recipient(&app, &unavailable) {
                    focus_recipient(&window);
                }
            }
            OpenMessage::Ready(label) => {
                if unavailable.contains(&label) {
                    continue;
                }
                ready.insert(label);
            }
            OpenMessage::Destroyed(label) => {
                if unavailable.contains(&label) {
                    continue;
                }
                ready.remove(&label);
                unavailable.insert(label.clone());
                revoke_recipient(&mut pending, &label);
            }
            OpenMessage::Claim { label, path, reply } => {
                if unavailable.contains(&label) {
                    let _ = reply.send(false);
                    continue;
                }
                // The frontend must claim BEFORE opening. An old event from a
                // destroyed recipient cannot claim a reassigned request.
                let live = app.get_webview_window(&label).is_some();
                let claimed = claim_pending(&mut pending, &label, &path, live);
                if reply.send(claimed).is_err() && claimed {
                    eprintln!("external-open recipient disconnected after accepting a request");
                }
            }
        }

        // Recover missing recipients even if their Destroyed message was lost.
        let missing: HashSet<_> = pending
            .iter()
            .filter_map(|request| request.recipient.as_ref())
            .filter(|label| app.get_webview_window(label).is_none())
            .cloned()
            .collect();
        for label in missing {
            revoke_recipient(&mut pending, &label);
            ready.remove(&label);
            unavailable.insert(label);
        }

        // One initial attempt and at most one immediate retry per message.
        for _attempt in 0..2 {
            let mut failed = None;
            let mut failed_creation = false;
            if pending.iter().any(|request| request.recipient.is_none()) {
                let window = match external_recipient(&app, &unavailable) {
                    Some(window) => Some(window),
                    None => {
                        let label = loop {
                            next_window += 1;
                            let label = format!("doc-external-{next_window}");
                            if !unavailable.contains(&label)
                                && app.get_webview_window(&label).is_none()
                            {
                                break label;
                            }
                        };
                        let request = pending
                            .iter_mut()
                            .find(|request| request.recipient.is_none())
                            .expect("an unassigned request exists");
                        let mut url = tauri::Url::parse("https://localhost/index.html")
                            .expect("static base URL is valid");
                        url.query_pairs_mut()
                            .append_pair("file", &request.path)
                            .append_pair("externalOpen", "1");
                        let relative = format!("index.html?{}", url.query().unwrap_or_default());
                        request.recipient = Some(label.clone());
                        request.notified = true; // URL notification, not acceptance.
                        match tauri::WebviewWindowBuilder::new(
                            &app,
                            &label,
                            tauri::WebviewUrl::App(relative.into()),
                        )
                        .title("Image Viewer")
                        .inner_size(1200.0, 820.0)
                        .zoom_hotkeys_enabled(PAGE_RECEIVES_PINCH)
                        .build()
                        {
                            Ok(window) => Some(window),
                            Err(error) => {
                                eprintln!("could not create external-open recipient {label}: {error}");
                                failed_creation = true;
                                failed = Some(label);
                                None
                            }
                        }
                    }
                };
                if let Some(window) = window {
                    focus_recipient(&window);
                    for request in &mut pending {
                        if request.recipient.is_none() {
                            request.recipient = Some(window.label().to_owned());
                        }
                    }
                }
            }

            if failed.is_none() {
                for request in &mut pending {
                    let Some(label) = request.recipient.as_deref() else {
                        continue;
                    };
                    if request.notified || !ready.contains(label) {
                        continue;
                    }
                    match app.emit_to(
                        tauri::EventTarget::webview_window(label),
                        "open-file",
                        request.path.clone(),
                    ) {
                        Ok(()) => request.notified = true,
                        Err(error) => {
                            eprintln!("external-open notification to {label} failed: {error}");
                            failed = Some(label.to_owned());
                            break;
                        }
                    }
                }
            }

            let Some(label) = failed else {
                break;
            };
            revoke_recipient(&mut pending, &label);
            ready.remove(&label);
            unavailable.insert(label.clone());
            if failed_creation {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.destroy();
                }
            }
        }
    }
}

#[cfg(test)]
mod external_open_tests {
    use super::*;

    fn assigned(path: &str, label: &str, notified: bool) -> PendingOpen {
        PendingOpen {
            path: path.into(),
            recipient: Some(label.into()),
            notified,
        }
    }

    #[test]
    fn selection_prefers_main_then_sorted_documents_and_excludes_failed_labels() {
        let labels = ["settings", "doc-b", "main", "doc-a"];
        let mut unavailable = HashSet::new();
        assert_eq!(select_recipient(labels, &unavailable), Some("main"));
        unavailable.insert("main".into());
        assert_eq!(select_recipient(labels, &unavailable), Some("doc-a"));
        unavailable.insert("doc-a".into());
        unavailable.insert("doc-b".into());
        assert_eq!(select_recipient(labels, &unavailable), None);
    }

    #[test]
    fn claims_require_live_notified_assignment_and_consume_one_repeated_path() {
        let mut pending = VecDeque::from([
            assigned("same.png", "main", false),
            assigned("same.png", "main", true),
        ]);
        assert!(!claim_pending(&mut pending, "main", "same.png", false));
        assert!(!claim_pending(&mut pending, "doc-other", "same.png", true));
        assert!(claim_pending(&mut pending, "main", "same.png", true));
        assert_eq!(pending.len(), 1);
        assert!(!claim_pending(&mut pending, "main", "same.png", true));
    }

    #[test]
    fn revoking_a_recipient_unassigns_only_its_requests() {
        let mut pending = VecDeque::from([
            assigned("a.png", "main", true),
            assigned("b.png", "doc-x", true),
        ]);
        revoke_recipient(&mut pending, "main");
        assert!(pending[0].recipient.is_none());
        assert!(!pending[0].notified);
        assert_eq!(pending[1].recipient.as_deref(), Some("doc-x"));
    }
}

#[tauri::command]
fn external_open_ready(
    window: tauri::WebviewWindow,
    state: State<'_, ExternalOpens>,
) -> Result<(), String> {
    state
        .0
        .send(OpenMessage::Ready(window.label().to_owned()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn claim_external_open(
    window: tauri::WebviewWindow,
    path: String,
    state: State<'_, ExternalOpens>,
) -> Result<bool, String> {
    let (reply, receiver) = mpsc::channel();
    state
        .0
        .send(OpenMessage::Claim {
            label: window.label().to_owned(),
            path,
            reply,
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// First non-flag argument, made absolute against the launching process's
/// working directory. Windows passes the image path this way when a file
/// association or "Open with" launches us.
fn first_file_arg<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Option<String> {
    let arg = args
        .into_iter()
        .skip(1)
        .find(|a| !a.starts_with('-') && !a.is_empty())?;
    let p = Path::new(&arg);
    Some(if p.is_absolute() {
        arg
    } else {
        cwd.join(p).to_string_lossy().into_owned()
    })
}

/* ---------- commands ---------- */

#[tauri::command]
fn initial_file(state: State<'_, InitialFile>) -> Option<String> {
    state.0.lock().ok()?.take()
}

/// The native open dialog. Run from Rust so the picked file is granted before
/// the page receives its path; the page has no dialog permission of its own.
#[tauri::command]
async fn pick_image(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("Images", &IMAGE_EXTS)
            .blocking_pick_file();
        let Some(picked) = picked else { return Ok(None) };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        let path = grant(&app, &path.to_string_lossy())
            .ok_or_else(|| "that is not an image file".to_string())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Images next to `path` (unsorted; the page sorts them by name), so the
/// frontend can offer next/previous through the folder.
#[tauri::command]
async fn sibling_images(path: String, grants: State<'_, Grants>) -> Result<Vec<String>, String> {
    let file = readable(&grants, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = file.parent().ok_or_else(|| "no parent folder".to_string())?;
        let out = std::fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| {
                let p = entry.ok()?.path();
                // `metadata()` follows symlinks; directories and broken links are skipped.
                if !is_image_path(&p) || !p.metadata().map(|m| m.is_file()).unwrap_or(false) {
                    return None;
                }
                Some(p.to_string_lossy().into_owned())
            })
            .collect();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct ImageInfo {
    size: u64,
    modified: u64,
}

#[tauri::command]
async fn image_info(path: String, grants: State<'_, Grants>) -> Result<ImageInfo, String> {
    let file = readable(&grants, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok(ImageInfo {
            size: meta.len(),
            modified,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Writes the PNG bytes in the request body as "<name>-dark.png" next to the
/// image named in the `x-path` header. Never overwrites: an existing name gets
/// "-dark-2", "-dark-3", … The source must be an image the user opened.
#[tauri::command]
async fn save_dark_copy(
    request: tauri::ipc::Request<'_>,
    grants: State<'_, Grants>,
) -> Result<String, String> {
    let raw_path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned())
        .ok_or_else(|| "missing source path".to_string())?;
    let source = readable(&grants, &raw_path)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw PNG bytes".into());
    };
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err("not PNG data".into());
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = source.parent().ok_or_else(|| "no parent folder".to_string())?;
        for n in 1..1000 {
            let name = dark_copy_name(&source, n).ok_or_else(|| "bad file name".to_string())?;
            let target = dir.join(name);
            // create_new fails if anything already has this name: never overwrite.
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
                Ok(mut file) => {
                    if let Err(e) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
                        drop(file);
                        let _ = std::fs::remove_file(&target);
                        return Err(e.to_string());
                    }
                    return Ok(target.to_string_lossy().into_owned());
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.to_string()),
            }
        }
        Err("too many dark copies already".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Trackpad pinch on Windows. WebView2 reports a pinch to the page as a
// ctrl+wheel WheelEvent, which the frontend claims to zoom the image. That
// event only exists while pinch zoom is enabled in WebView2, which wry ties to
// `zoom_hotkeys_enabled` and which must be set before the first navigation, so
// every window is built with it on Windows. The browser zoom it also enables
// never fires, because the frontend preventDefault()s ctrl+wheel and ctrl+±/0.
// The frontend mirrors this in openInNewWindow().
const PAGE_RECEIVES_PINCH: bool = cfg!(target_os = "windows");

fn image_mime(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    }
}

/// The `asset` scheme, served by hand instead of Tauri's built-in asset
/// protocol: only images in granted folders, checked lexically before any
/// filesystem access. Same scheme name, so convertFileSrc() and the CSP match.
fn asset_response(uri_path: &str, grants: &Grants) -> tauri::http::Response<Vec<u8>> {
    let status = |code: u16| {
        tauri::http::Response::builder()
            .status(code)
            .body(Vec::new())
            .expect("static response is valid")
    };
    let raw = percent_encoding::percent_decode_str(uri_path.trim_start_matches('/'))
        .decode_utf8_lossy()
        .into_owned();
    let Ok(path) = readable(grants, &raw) else {
        return status(403);
    };
    match std::fs::read(&path) {
        Ok(bytes) => tauri::http::Response::builder()
            .header("Content-Type", image_mime(&path))
            // The page draws images into a canvas for copy and "save dark
            // copy"; without this the canvas would be tainted.
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .expect("image response is valid"),
        Err(_) => status(404),
    }
}

fn queue_open(app: &tauri::AppHandle, path: String) {
    // Grant first, so the receiving window can read it. Non-images are ignored.
    let Some(path) = grant(app, &path) else { return };
    if let Err(error) = app
        .state::<ExternalOpens>()
        .0
        .send(OpenMessage::Open(Some(path.to_string_lossy().into_owned())))
    {
        eprintln!("could not queue external file open: {error}");
    }
}

fn main() {
    let cwd = std::env::current_dir().unwrap_or_default();
    let initial = first_file_arg(std::env::args(), &cwd);
    let (open_sender, open_receiver) = mpsc::channel();
    let grants = Grants(Mutex::new(GrantSet::default()));
    let initial = initial.and_then(|p| {
        grants
            .0
            .lock()
            .ok()?
            .grant(&p)
            .map(|p| p.to_string_lossy().into_owned())
    });

    tauri::Builder::default()
        .manage(ExternalOpens(open_sender))
        .manage(grants)
        // Must be registered first: a second launch forwards its argv here
        // instead of opening a second process.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            match first_file_arg(argv, Path::new(&cwd)) {
                Some(path) => queue_open(app, path),
                None => {
                    let _ = app.state::<ExternalOpens>().0.send(OpenMessage::Open(None));
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_asynchronous_uri_scheme_protocol("asset", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let uri_path = request.uri().path().to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(asset_response(&uri_path, &app.state::<Grants>()));
            });
        })
        .on_window_event(|window, event| {
            match event {
                // Dropped files are granted here, before the page hears about
                // them, then handed over as "dropped-files". The page ignores
                // Tauri's own tauri://drag-drop paths for opening.
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    let app = window.app_handle();
                    let granted: Vec<String> = paths
                        .iter()
                        .filter_map(|p| grant(app, &p.to_string_lossy()))
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect();
                    let _ = app.emit_to(
                        tauri::EventTarget::webview_window(window.label()),
                        "dropped-files",
                        granted,
                    );
                }
                tauri::WindowEvent::Destroyed => {
                    if let Some(next) = external_recipient(
                        window.app_handle(),
                        &HashSet::from([window.label().to_owned()]),
                    ) {
                        focus_recipient(&next);
                    }
                    let _ = window
                        .state::<ExternalOpens>()
                        .0
                        .send(OpenMessage::Destroyed(window.label().to_owned()));
                }
                _ => {}
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || route_external_opens(handle, open_receiver));

            // The main window is `create: false` in tauri.conf.json so it can be
            // built here with pinch enabled. See PAGE_RECEIVES_PINCH.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .ok_or("tauri.conf.json has no main window")?
                .clone();
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .zoom_hotkeys_enabled(PAGE_RECEIVES_PINCH)
                .build()?;
            Ok(())
        })
        .manage(InitialFile(Mutex::new(initial)))
        .invoke_handler(tauri::generate_handler![
            initial_file,
            pick_image,
            sibling_images,
            image_info,
            save_dark_copy,
            external_open_ready,
            claim_external_open
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Image Viewer")
        .run(|_app, _event| {
            // macOS never passes a double-clicked image as an argument: it
            // arrives as an Apple Event and goes through the same router.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                for path in urls.into_iter().filter_map(|url| url.to_file_path().ok()) {
                    queue_open(_app, path.to_string_lossy().into_owned());
                }
            }
        });
}

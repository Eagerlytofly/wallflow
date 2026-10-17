// Wallpaper helper for macOS (Sonoma / Sequoia).
//
// Two ways to change the wallpaper, because they have very different costs:
//
//   desktop  NSWorkspace.setDesktopImageURL — ~10 ms, no flicker. Used for
//            fast rotation (10 s is fine). It does not touch the lock screen.
//   store    Rewrite ~/Library/Application Support/com.apple.wallpaper/Store/Index.plist
//            and restart WallpaperAgent. This is the only way to change the
//            lock screen, but the restart briefly flashes the desktop black.
//            Used sparingly — e.g. once when the screen locks.
//
// Commands (one-shot):
//   screens | current | state
//   desktop --image PATH
//   store   --image PATH [--lock] [--placement N] [--restart]
//   set     --image PATH [--lock] [--placement N]     (= store + restart)
//   restart
//   restore --backup PATH
//
// Also `agent`: a long-lived line-delimited JSON RPC loop, so the Node side
// pays AppKit startup only once instead of on every wallpaper change.

import AppKit
import CoreGraphics
import Darwin
import Foundation

var storePath = ("~/Library/Application Support/com.apple.wallpaper/Store/Index.plist" as NSString).expandingTildeInPath

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(("error: " + message + "\n").data(using: .utf8)!)
    exit(code)
}

func jsonData(_ object: Any) -> Data {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    else { return Data("{\"ok\":false,\"error\":\"encode\"}".utf8) }
    return data
}

func printJSON(_ object: Any) {
    FileHandle.standardOutput.write(jsonData(object))
    FileHandle.standardOutput.write(Data("\n".utf8))
}

// MARK: - plist helpers

func readStore(_ path: String) -> [String: Any] {
    guard FileManager.default.fileExists(atPath: path) else {
        return [
            "AllSpacesAndDisplays": [String: Any](),
            "Displays": [String: Any](),
            "Spaces": [String: Any](),
            "SystemDefault": [String: Any](),
        ]
    }
    guard let data = FileManager.default.contents(atPath: path),
          let any = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
          let root = any as? [String: Any]
    else { fail("cannot read wallpaper store at \(path)") }
    return root
}

/// Binary plists cannot encode NSNull, but the wallpaper store uses null for
/// "no shuffle". Drop those keys before serialising.
func sanitized(_ value: Any) -> Any? {
    if value is NSNull { return nil }
    if let dict = value as? [String: Any] {
        var out: [String: Any] = [:]
        for (key, item) in dict {
            if let clean = sanitized(item) { out[key] = clean }
        }
        return out
    }
    if let array = value as? [Any] {
        return array.compactMap { sanitized($0) }
    }
    return value
}

func writeStore(_ root: [String: Any], to path: String) {
    do {
        let clean = sanitized(root) as? [String: Any] ?? root
        let data = try PropertyListSerialization.data(fromPropertyList: clean, format: .binary, options: 0)
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let tmp = path + ".tmp-\(getpid())"
        try data.write(to: URL(fileURLWithPath: tmp), options: .atomic)
        _ = try FileManager.default.replaceItemAt(URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: tmp))
    } catch {
        fail("cannot write wallpaper store: \(error.localizedDescription)")
    }
}

func makeImageChoice(template: [String: Any]?, imageURL: String, placement: Int) -> [String: Any] {
    var choice = template ?? [:]
    choice["Provider"] = "com.apple.wallpaper.choice.image"
    choice["Files"] = [["relative": imageURL]]

    var config: [String: Any] = [:]
    if let data = choice["Configuration"] as? Data,
       let old = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
       let oldDict = old as? [String: Any] {
        config = oldDict
    }
    config["placement"] = placement
    if config["backgroundColor"] == nil {
        // System Settings always stores a colour space+components pair; some
        // macOS builds reject image choices that omit it.
        if let space = try? PropertyListSerialization.data(fromPropertyList: "kCGColorSpaceGenericRGB", format: .binary, options: 0) {
            config["backgroundColor"] = ["colorSpace": space, "components": [0.06, 0.07, 0.09, 1.0]]
        }
    }
    if let data = try? PropertyListSerialization.data(fromPropertyList: config, format: .binary, options: 0) {
        choice["Configuration"] = data
    }
    return choice
}

func firstChoice(_ container: [String: Any]?) -> [String: Any]? {
    guard let content = container?["Content"] as? [String: Any],
          let choices = content["Choices"] as? [[String: Any]] else { return nil }
    return choices.first
}

func applyChoice(to section: inout [String: Any], choice: [String: Any]) {
    var content = section["Content"] as? [String: Any] ?? [:]
    content["Choices"] = [choice]
    section["Content"] = content
    section["LastSet"] = Date()
    section["LastUse"] = Date()
}

func currentURLs(from container: [String: Any]?) -> [String] {
    guard let content = container?["Content"] as? [String: Any],
          let choices = content["Choices"] as? [[String: Any]] else { return [] }
    return choices.flatMap { choice -> [String] in
        guard let files = choice["Files"] as? [[String: Any]] else { return [] }
        return files.compactMap { $0["relative"] as? String }
    }
}

func desktopURLFromStore(_ path: String) -> String? {
    let store = readStore(path)
    let all = store["AllSpacesAndDisplays"] as? [String: Any] ?? [:]
    return currentURLs(from: all["Desktop"] as? [String: Any]).first
}

func restartWallpaperAgent() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/killall")
    p.arguments = ["WallpaperAgent"]
    p.standardError = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    try? p.run()
    p.waitUntilExit()
    Thread.sleep(forTimeInterval: 0.25)
}

func unifiedEnabled() -> Bool {
    let key = "useAsDesktopWallpaperAndIdleWallpaper" as CFString
    let domain = "com.apple.wallpaper" as CFString
    let value = CFPreferencesCopyAppValue(key, domain) as? Bool
    return value ?? false
}

func screenSaverUnifiedEnabled() -> Bool {
    let key = "useAsDesktopWallpaperAndScreenSaverWallpaper" as CFString
    let domain = "com.apple.wallpaper" as CFString
    return (CFPreferencesCopyAppValue(key, domain) as? Bool) ?? false
}

func setUnified(_ enabled: Bool) {
    let domain = "com.apple.wallpaper" as CFString
    for key in [
        "useAsDesktopWallpaperAndIdleWallpaper",
        "useAsDesktopWallpaperAndScreenSaverWallpaper",
    ] {
        CFPreferencesSetAppValue(key as CFString, (enabled ? kCFBooleanTrue : kCFBooleanFalse), domain)
    }
    CFPreferencesAppSynchronize(domain)
}

// MARK: - actions

@discardableResult
func setDesktop(_ path: String) -> [String: Any] {
    let url = URL(fileURLWithPath: path).standardizedFileURL
    guard FileManager.default.fileExists(atPath: url.path) else { return ["ok": false, "error": "image not found: \(url.path)"] }
    var applied = 0
    for screen in NSScreen.screens {
        do {
            try NSWorkspace.shared.setDesktopImageURL(url, for: screen, options: [:])
            applied += 1
        } catch {
            // keep going; report the count
        }
    }
    return ["ok": applied > 0, "desktop": url.absoluteString, "screens": applied]
}

func writeChoice(image: String, lock: Bool, placement: Int) -> [String: Any] {
    let abs = URL(fileURLWithPath: image).standardizedFileURL
    guard FileManager.default.fileExists(atPath: abs.path) else { return ["ok": false, "error": "image not found: \(abs.path)"] }
    let url = abs.absoluteString

    var store = readStore(storePath)
    var all = store["AllSpacesAndDisplays"] as? [String: Any] ?? [:]
    let unified = unifiedEnabled() || (all["Desktop"] == nil && all["Idle"] != nil)
    let template = firstChoice(all["Desktop"] as? [String: Any]) ?? firstChoice(all["Idle"] as? [String: Any])
    let choice = makeImageChoice(template: template, imageURL: url, placement: placement)

    // Unified mode = "desktop and lock screen use the same wallpaper".
    // WallpaperAgent then keeps only an Idle section; writing Desktop makes it
    // churn on every restart, so skip it.
    if unified {
        all.removeValue(forKey: "Desktop")
    } else {
        var desktop = all["Desktop"] as? [String: Any] ?? [:]
        applyChoice(to: &desktop, choice: choice)
        all["Desktop"] = desktop
    }

    var idle = all["Idle"] as? [String: Any] ?? [:]
    applyChoice(to: &idle, choice: choice)
    all["Idle"] = idle
    store["AllSpacesAndDisplays"] = all

    if var displays = store["Displays"] as? [String: Any], !displays.isEmpty {
        for (key, value) in displays {
            guard var section = value as? [String: Any] else { continue }
            if unified {
                section.removeValue(forKey: "Desktop")
            } else if var d = section["Desktop"] as? [String: Any] {
                applyChoice(to: &d, choice: choice)
                section["Desktop"] = d
            }
            var i = section["Idle"] as? [String: Any] ?? [:]
            applyChoice(to: &i, choice: choice)
            section["Idle"] = i
            displays[key] = section
        }
        store["Displays"] = displays
    }

    if var def = store["SystemDefault"] as? [String: Any] {
        if unified {
            def.removeValue(forKey: "Desktop")
        } else if var d = def["Desktop"] as? [String: Any] {
            applyChoice(to: &d, choice: choice)
            def["Desktop"] = d
        }
        var i = def["Idle"] as? [String: Any] ?? [:]
        applyChoice(to: &i, choice: choice)
        def["Idle"] = i
        store["SystemDefault"] = def
    }

    writeStore(store, to: storePath)
    return ["ok": true, "image": abs.path, "unified": unified, "idle": [url], "lock": lock]
}

func sessionState() -> [String: Any] {
    let dict = CGSessionCopyCurrentDictionary() as NSDictionary? as? [String: Any]
    let locked = (dict?["CGSSessionScreenIsLocked"] as? Bool) ?? false
    let asleep = CGDisplayIsAsleep(CGMainDisplayID())
    let desktop = NSScreen.main.flatMap { NSWorkspace.shared.desktopImageURL(for: $0)?.absoluteString } ?? ""
    return ["ok": true, "locked": locked, "asleep": asleep, "desktop": desktop, "unified": unifiedEnabled(), "screenSaverUnified": screenSaverUnifiedEnabled()]
}

func currentState() -> [String: Any] {
    let store = readStore(storePath)
    let all = store["AllSpacesAndDisplays"] as? [String: Any] ?? [:]
    let desktop = all["Desktop"] as? [String: Any]
    let idle = all["Idle"] as? [String: Any]
    var result: [String: Any] = [
        "store": storePath,
        "desktop": currentURLs(from: desktop),
        "idle": currentURLs(from: idle),
        "desktopProvider": (firstChoice(desktop)?["Provider"] as? String) ?? "",
        "idleProvider": (firstChoice(idle)?["Provider"] as? String) ?? "",
        "unified": unifiedEnabled(),
        "screenSaverUnified": screenSaverUnifiedEnabled(),
    ]
    if let screen = NSScreen.main, let url = NSWorkspace.shared.desktopImageURL(for: screen) {
        result["legacyDesktop"] = url.absoluteString
    }
    result["screens"] = screensJSON()
    return result
}

func screensJSON() -> [[String: Any]] {
    var out: [[String: Any]] = []
    for (i, screen) in NSScreen.screens.enumerated() {
        let scale = screen.backingScaleFactor
        let f = screen.frame
        out.append([
            "index": i,
            "name": screen.localizedName,
            "width": Int(f.width * scale),
            "height": Int(f.height * scale),
            "scale": scale,
            "main": i == 0,
        ])
    }
    return out
}

func restoreBackup(_ backup: String) -> [String: Any] {
    guard FileManager.default.fileExists(atPath: backup) else { return ["ok": false, "error": "backup not found: \(backup)"] }
    do {
        let data = try Data(contentsOf: URL(fileURLWithPath: backup))
        try data.write(to: URL(fileURLWithPath: storePath), options: .atomic)
        // Restore the "desktop and lock screen use the same wallpaper" flag.
        let backupStore = readStore(backup)
        let backupAll = backupStore["AllSpacesAndDisplays"] as? [String: Any] ?? [:]
        let backupDesktop = currentURLs(from: backupAll["Desktop"] as? [String: Any])
        let backupIdle = currentURLs(from: backupAll["Idle"] as? [String: Any])
        setUnified(!backupDesktop.isEmpty && backupDesktop == backupIdle)

        // Reset the fast desktop channel too, otherwise the legacy picture
        // keeps overriding the restored store value.
        if let urlString = desktopURLFromStore(backup),
           let url = URL(string: urlString),
           FileManager.default.fileExists(atPath: url.path) {
            _ = setDesktop(url.path)
        }
        restartWallpaperAgent()
        return ["ok": true, "restored": backup]
    } catch {
        return ["ok": false, "error": "restore failed: \(error.localizedDescription)"]
    }
}

// MARK: - one-shot CLI

func runOneShot(_ command: String, _ opts: [String: String], _ flags: Set<String>) {
    switch command {
    case "screens":
        printJSON(screensJSON())
    case "current":
        printJSON(currentState())
    case "state":
        printJSON(sessionState())
    case "desktop":
        guard let image = opts["image"] else { fail("--image is required") }
        printJSON(setDesktop(image))
    case "restart":
        restartWallpaperAgent()
        printJSON(["ok": true])
    case "unified":
        let enabled = opts["enabled"] != "false" && !flags.contains("off")
        setUnified(enabled)
        restartWallpaperAgent()
        printJSON(["ok": true, "unified": enabled])
    case "store":
        guard let image = opts["image"] else { fail("--image is required") }
        let lock = flags.contains("lock") || opts["lock"] == "true"
        let placement = Int(opts["placement"] ?? "1") ?? 1
        var result = writeChoice(image: image, lock: lock, placement: placement)
        if flags.contains("restart") || opts["restart"] == "true" {
            restartWallpaperAgent()
            result["restarted"] = true
        }
        printJSON(result)
    case "set":
        guard let image = opts["image"] else { fail("--image is required") }
        let lock = flags.contains("lock") || opts["lock"] == "true"
        let placement = Int(opts["placement"] ?? "1") ?? 1
        var result = writeChoice(image: image, lock: lock, placement: placement)
        restartWallpaperAgent()
        result["restarted"] = true
        printJSON(result)
    case "restore":
        guard let backup = opts["backup"] else { fail("--backup is required") }
        printJSON(restoreBackup(backup))
    case "help", "-h", "--help":
        print("""
        usage: wallpaper-helper <command> [options]

          screens
          current
          state
          desktop --image PATH
          store   --image PATH [--lock] [--placement 0-5] [--restart]
          set     --image PATH [--lock] [--placement 0-5]
          restart
          restore --backup PATH
          agent                     line-delimited JSON RPC (long-lived)

        placement: 0 auto, 1 fill, 2 fit, 3 stretch, 4 center, 5 tile
        """)
    default:
        fail("unknown command: \(command)")
    }
}

// MARK: - persistent agent

func respond(_ id: Any, _ body: [String: Any]) {
    var out = body
    out["id"] = id
    FileHandle.standardOutput.write(jsonData(out))
    FileHandle.standardOutput.write(Data("\n".utf8))
    fflush(stdout)
}

func runAgent() {
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        guard let data = trimmed.data(using: .utf8),
              let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let cmd = req["cmd"] as? String else { continue }
        let id = req["id"] ?? 0
        let image = req["image"] as? String
        let lock = req["lock"] as? Bool ?? true
        let restart = req["restart"] as? Bool ?? false
        let placement = req["placement"] as? Int ?? 1

        switch cmd {
        case "desktop":
            guard let image else { respond(id, ["ok": false, "error": "image required"]); continue }
            respond(id, setDesktop(image))
        case "store":
            guard let image else { respond(id, ["ok": false, "error": "image required"]); continue }
            var result = writeChoice(image: image, lock: lock, placement: placement)
            if restart { restartWallpaperAgent(); result["restarted"] = true }
            respond(id, result)
        case "restart":
            restartWallpaperAgent()
            respond(id, ["ok": true])
        case "unified":
            let enabled = req["enabled"] as? Bool ?? true
            setUnified(enabled)
            restartWallpaperAgent()
            respond(id, ["ok": true, "unified": enabled])
        case "state":
            respond(id, sessionState())
        case "current":
            respond(id, currentState())
        case "screens":
            respond(id, ["ok": true, "screens": screensJSON()])
        case "quit":
            respond(id, ["ok": true])
            exit(0)
        default:
            respond(id, ["ok": false, "error": "unknown command: \(cmd)"])
        }
    }
}

// MARK: - entry

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    runOneShot("help", [:], [])
    exit(0)
}

if command == "agent" {
    runAgent()
    exit(0)
}

var opts: [String: String] = [:]
var flags = Set<String>()
var i = 1
while i < args.count {
    let a = args[i]
    if a.hasPrefix("--") {
        let key = String(a.dropFirst(2))
        if i + 1 < args.count && !args[i + 1].hasPrefix("--") {
            opts[key] = args[i + 1]
            i += 2
        } else {
            flags.insert(key)
            i += 1
        }
    } else {
        i += 1
    }
}

runOneShot(command, opts, flags)

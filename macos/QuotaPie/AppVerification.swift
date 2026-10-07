import AppKit
import Foundation

/// Debug-bundle smoke observations. Expected results stay in the external runner;
/// the app reports what its real fetch, model selection and rendering produced.
struct AppVerification: Decodable {
    let endpoint: String
    let reportPath: String
    let profiles: [CodexDesktopProfile]
    let runningProfileIDs: [String]
    let frontmostProfileID: String?
    let initialSection: String?

    static let current: AppVerification? = {
#if DEBUG
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: "--verification") else { return nil }
        guard Bundle.main.bundleIdentifier?.hasPrefix("local.quotapie.verification.") == true,
              index + 1 < args.count,
              let data = FileManager.default.contents(atPath: args[index + 1]),
              let request = try? JSONDecoder().decode(Self.self, from: data),
              let url = URL(string: request.endpoint), url.scheme == "http", url.host == "127.0.0.1",
              url.port != nil, url.user == nil, url.password == nil else {
            fputs("Invalid isolated verification request.\n", stderr)
            exit(2)
        }
        return request
#else
        return nil
#endif
    }()

    private func identity(_ id: String) -> CodexProcessIdentity? {
        guard let profile = profiles.first(where: { $0.id == id }) else { return nil }
        return CodexProcessIdentity(codexHome: profile.codexHome, appData: profile.appData)
    }

    func selectInitialAccount(in model: PopoverModel) {
        model.selectInitialCodexAccount(frontmost: frontmostProfileID.flatMap(identity),
                                        running: runningProfileIDs.compactMap(identity), profiles: profiles)
        if let initialSection, let section = DetailSection(rawValue: initialSection) { model.showDetails(section) }
    }

    func armTimeout() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { exit(3) }
    }

    func record(model: PopoverModel, item: NSStatusItem, content: NSViewController?) {
        var rendered = false
        var accountSelectorVerified = false
        let expectsSelector = model.detailSection == nil && (model.payload?.accounts.filter(\.enabled).count ?? 0) > 1
        func findSelector(_ view: NSView) -> AccountMenuButton? {
            if let button = view as? AccountMenuButton, button.identifier?.rawValue == "account-selector" { return button }
            return view.subviews.lazy.compactMap { findSelector($0) }.first
        }
        if let button = item.button,
           let bitmap = button.bitmapImageRepForCachingDisplay(in: button.bounds) {
            button.cacheDisplay(in: button.bounds, to: bitmap)
            if let png = bitmap.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: reportPath + ".menu.png"), options: .atomic)
            }
        }
        if let content {
            let window = NSWindow(contentViewController: content)
            window.setContentSize(NSSize(width: model.detailSection == nil ? 380 : 460, height: 560))
            content.view.layoutSubtreeIfNeeded()
            if let selector = findSelector(content.view) {
                let focused = window.makeFirstResponder(selector)
                accountSelectorVerified = focused && selector.focusRingType == .none
                    && selector.title == model.selectedAccount?.accountLabel
                    && selector.action != nil
            }
            if let bitmap = content.view.bitmapImageRepForCachingDisplay(in: content.view.bounds) {
                content.view.cacheDisplay(in: content.view.bounds, to: bitmap)
                if let png = bitmap.representation(using: .png, properties: [:]) {
                    do {
                        // A hosting view is transparent; composite onto its window
                        // background so text remains readable in standalone evidence.
                        let image = NSImage(size: content.view.bounds.size)
                        image.lockFocus()
                        NSColor.windowBackgroundColor.setFill()
                        content.view.bounds.fill()
                        NSImage(data: png)?.draw(in: content.view.bounds)
                        image.unlockFocus()
                        guard let tiff = image.tiffRepresentation,
                              let flattened = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { exit(4) }
                        try flattened.write(to: URL(fileURLWithPath: reportPath + ".png"), options: .atomic)
                        rendered = true
                    } catch { rendered = false }
                }
            }
        }
        let report: [String: Any] = [
            "pid": ProcessInfo.processInfo.processIdentifier,
            "connected": model.lastError == nil && model.lastSuccessAt != nil,
            "selectedAccount": model.selectedAccount?.id as Any? ?? NSNull(),
            "remainingPercent": model.selectedHeadline?.remainingPercent as Any? ?? NSNull(),
            "routedAccount": model.latestRoutedAccount?.id as Any? ?? NSNull(),
            "routedRemainingPercent": model.latestRoutedHeadline?.remainingPercent as Any? ?? NSNull(),
            "routedQuotaKind": model.latestRoutedHeadline?.kind as Any? ?? NSNull(),
            "poolError": model.payload?.accountPool?.error as Any? ?? NSNull(),
            "menuAccessibleLabel": item.button?.accessibilityLabel() ?? "",
            "menuHasImage": item.button?.image != nil,
            "menuVisible": item.isVisible,
            "viewRendered": rendered,
            "detailSection": model.detailSection?.rawValue as Any? ?? NSNull(),
            "recentWorkIDs": model.payload?.recentWork.map(\.id) ?? [],
            "accountSelectorVerified": !expectsSelector || accountSelectorVerified,
            "statusFailure": model.statusFailure?.rawValue as Any? ?? NSNull(),
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
            try data.write(to: URL(fileURLWithPath: reportPath), options: .atomic)
        } catch { exit(4) }
        NSApp.terminate(nil)
    }
}

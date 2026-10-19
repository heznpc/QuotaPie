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
    let initialAccountID: String?
    let navigationClicks: [NavigationClick]?
    struct NavigationClick: Decodable { let x: Double; let y: Double }
    let focusedResumeTaskID: String?
    let contentHeight: Double?
    let appearance: String?
    let interactive: Bool?
    let inspectAutoResume: Bool?
    let fastQuota: Bool?
    let quotaCachePath: String?
    private static var recordedFastFirst = false
    private static var initialInspectionApplied = false
    private static var interactiveWindow: NSWindow?

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
        if let appearance { NSApp.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua) }
        model.selectInitialCodexAccount(frontmost: frontmostProfileID.flatMap(identity),
                                        running: runningProfileIDs.compactMap(identity), profiles: profiles)
        if let initialSection, let section = DetailSection(rawValue: initialSection) {
            model.showDetails(section, taskID: focusedResumeTaskID)
        }
    }

    func armTimeout() {
        guard interactive != true else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { exit(3) }
    }

    func record(model: PopoverModel, item: NSStatusItem, content: NSViewController?, workLoadAttempt: Int = 0, mountedWindow: NSWindow? = nil, phase: String? = nil, navigationStep: Int = 0) {
        if !Self.initialInspectionApplied, let initialAccountID,
           let account = model.enabledAccounts.first(where: { $0.id == initialAccountID }) {
            Self.initialInspectionApplied = true
            model.showAccount(account)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                record(model: model, item: item, content: content, mountedWindow: mountedWindow)
            }
            return
        }
        let waitingForDetails = fastQuota == true && !model.detailsLoaded && model.detailsError == nil
        if phase == nil && waitingForDetails && Self.recordedFastFirst { return }
        let navigating = navigationStep < (navigationClicks?.count ?? 0)
        let outputPath = reportPath + (phase.map { "." + $0 } ?? (waitingForDetails ? ".first" : (navigating ? ".navigation-\(navigationStep)" : "")))
        var rendered = false
        var mountedContentWindow: NSWindow?
        var autoResumeControls: [[String: Any]] = []
        var scrollRegions: [[String: Double]] = []
        if let button = item.button,
           let bitmap = button.bitmapImageRepForCachingDisplay(in: button.bounds) {
            button.cacheDisplay(in: button.bounds, to: bitmap)
            if let png = bitmap.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: outputPath + ".menu.png"), options: .atomic)
            }
        }
        if let content {
            let window = mountedWindow ?? Self.interactiveWindow ?? NSWindow(contentViewController: content)
            mountedContentWindow = window
            if let appearance { window.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua) }
            let fittingSize = content.view.fittingSize
            let height = contentHeight ?? Double(fittingSize.height)
            window.setContentSize(NSSize(width: fittingSize.width, height: min(1200, max(1, height))))
            if interactive == true, Self.interactiveWindow == nil {
                Self.interactiveWindow = window
                NSApp.setActivationPolicy(.regular)
                window.title = "QuotaPie — Isolated Verification"
                window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
            }
            content.view.layoutSubtreeIfNeeded()
            if mountedWindow == nil, phase == nil, fastQuota != true {
                // Let the mounted hosting view finish its layout before
                // capturing pixels and using their coordinates for input.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    withExtendedLifetime(window) { record(model: model, item: item, content: content, mountedWindow: window, navigationStep: navigationStep) }
                }
                return
            }
            func inspectScrollRegions(_ view: NSView) {
                if let scroll = view as? NSScrollView {
                    scrollRegions.append(["viewportHeight": scroll.contentView.bounds.height,
                        "documentHeight": scroll.documentView?.bounds.height ?? 0])
                }
                for child in view.subviews { inspectScrollRegions(child) }
            }
            inspectScrollRegions(content.view)
            // Mount the real SwiftUI surface first so its authenticated work
            // request runs. Only this asynchronous section needs readiness.
            if model.detailSection == .work, model.lastError == nil,
               model.automaticWorkLoadedPolicyIDs == nil, workLoadAttempt < 100 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    withExtendedLifetime(window) {
                        record(model: model, item: item, content: content, workLoadAttempt: workLoadAttempt + 1, mountedWindow: window)
                    }
                }
                return
            }
#if DEBUG
            // Read the actual mounted controls. SwiftUI's virtual AX tree is
            // unavailable without an external accessibility session, so labels
            // below are verified from the rendered pixels instead.
            func inspectControls(_ view: NSView) {
                if let control = view as? NSControl, control.responds(to: NSSelectorFromString("state")),
                   let state = control.value(forKey: "state") as? NSNumber {
                    let bounds = control.convert(control.bounds, to: content.view)
                    let fraction = bounds.midY / content.view.bounds.height
                    autoResumeControls.append(["value": state, "enabled": control.isEnabled,
                        "top": content.view.isFlipped ? fraction : 1 - fraction,
                        "kind": String(describing: type(of: control))])
                }
                for child in view.subviews { inspectControls(child) }
            }
            if inspectAutoResume == true { inspectControls(content.view) }
#endif
            content.view.display()
            window.displayIfNeeded()
            if let bitmap = content.view.bitmapImageRepForCachingDisplay(in: content.view.bounds) {
                content.view.cacheDisplay(in: content.view.bounds, to: bitmap)
                if let png = bitmap.representation(using: .png, properties: [:]) {
                    do {
                        // A hosting view is transparent; composite onto its window
                        // background so text remains readable in standalone evidence.
                        let image = NSImage(size: content.view.bounds.size)
                        image.lockFocus()
                        content.view.effectiveAppearance.performAsCurrentDrawingAppearance {
                            NSColor.windowBackgroundColor.setFill()
                            content.view.bounds.fill()
                        }
                        NSImage(data: png)?.draw(in: content.view.bounds)
                        image.unlockFocus()
                        guard let tiff = image.tiffRepresentation,
                              let flattened = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { exit(4) }
                        try flattened.write(to: URL(fileURLWithPath: outputPath + ".png"), options: .atomic)
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
            "menuText": item.button?.title ?? "",
            "viewWidth": content?.view.bounds.width ?? 0,
            "viewHeight": content?.view.bounds.height ?? 0,
            "appearance": content?.view.effectiveAppearance.name.rawValue ?? "",
            "scrollRegions": scrollRegions,
            "viewRendered": rendered,
            "detailSection": model.detailSection?.rawValue as Any? ?? NSNull(),
            "isShowingAccountList": model.isShowingAccountList,
            "inspectedAccount": model.inspectedAccountID as Any? ?? NSNull(),
            "displayedAccount": model.displayedAccount?.id as Any? ?? NSNull(),
            "enabledAccountIDs": model.enabledAccounts.map(\.id),
            "focusedResumeTaskID": model.focusedResumeTaskID as Any? ?? NSNull(),
            "activeTaskIDs": model.activeTasks.map(\.id),
            "managedJobIDs": model.payload?.jobs.map(\.id) ?? [],
            "hostGoalIDs": model.payload?.hostGoals?.items.map(\.id) ?? [],
            "hostGoalReadStates": model.payload?.hostGoals?.items.map {
                $0.displayReadState(at: Date().timeIntervalSince1970 * 1_000, transportUnavailable: model.lastError != nil)
            } ?? [],
            "efficiencyInsightIDs": model.payload?.compaction?.savings?.insights?.map(\.id) ?? [],
            "testOnlySavings": model.payload?.compaction?.savings?.policy?.testOnly as Any? ?? NSNull(),
            "recentWorkIDs": model.payload?.recentWork.map(\.id) ?? [],
            "automaticWorkLoadedPolicyIDs": model.automaticWorkLoadedPolicyIDs as Any? ?? NSNull(),
            "autoResumeControls": autoResumeControls,
            "locale": Strings.language.rawValue,
            "excludedPostIDs": model.payload?.resetSignals?.excludedPosts?.map(\.identity) ?? [],
            "pendingResetIDs": model.payload?.resetSignals?.pendingResets(nowMs: Date().timeIntervalSince1970 * 1000).map(\.id) ?? [],
            "profileDockIcons": CodexProfilesModel.shared.profiles.compactMap { $0.dockIcon?.rawValue },
            "statusFailure": model.statusFailure?.rawValue as Any? ?? NSNull(),
            "showingStartupCache": model.showingStartupCache,
            "measurementAtMs": model.measurementDate.map { $0.timeIntervalSince1970 * 1_000 } as Any? ?? NSNull(),
            "canActOnTasks": model.canActOnTasks,
            "hasActionToken": model.payload?.actionToken != nil,
            "detailsLoaded": model.detailsLoaded,
            "detailsLoading": model.detailsLoading,
            "detailsError": model.detailsError as Any? ?? NSNull(),
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
            try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
        } catch { exit(4) }
        if phase != nil { return }
        if navigating, let click = navigationClicks?[navigationStep], let window = mountedContentWindow,
           let view = content?.view {
            // Exercise the mounted SwiftUI button through its window event path.
            // Coordinates come from independently recognized screenshot text;
            // no model action or global user-input event is injected here.
            window.orderFront(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                view.layoutSubtreeIfNeeded()
                let point = view.convert(NSPoint(x: view.bounds.minX + view.bounds.width * click.x,
                    y: view.bounds.minY + (view.isFlipped ? view.bounds.height * click.y : view.bounds.height * (1 - click.y))), to: nil)
                let trace: [String: Any] = ["point": NSStringFromPoint(point), "bounds": NSStringFromRect(view.bounds),
                    "frame": NSStringFromRect(view.frame), "flipped": view.isFlipped,
                    "window": NSStringFromRect(window.frame), "step": navigationStep]
                if let data = try? JSONSerialization.data(withJSONObject: trace) {
                    try? data.write(to: URL(fileURLWithPath: outputPath + ".click.json"))
                }
                for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                    if let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                        timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                        context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) {
                        window.sendEvent(event)
                    }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    record(model: model, item: item, content: content, mountedWindow: window, navigationStep: navigationStep + 1)
                }
            }
            return
        }
        if waitingForDetails { Self.recordedFastFirst = true; return }
        if interactive != true { NSApp.terminate(nil) }
    }
}

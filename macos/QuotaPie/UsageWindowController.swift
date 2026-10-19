import AppKit
import SwiftUI

private final class UsageWindowPresentation: ObservableObject {
    @Published var revision = 0
    @Published var section = 0
}

/// The menu bar owns this singleton; closing the analysis never closes a host.
final class UsageWindowController: NSWindowController, NSWindowDelegate {
    private let model: PopoverModel
    private let presentation = UsageWindowPresentation()
    private let local = UsageReportStore()
    private let official = OfficialUsageStore()

    init(model: PopoverModel) {
        self.model = model
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1060, height: 780),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        super.init(window: window)
        window.title = Strings.t("usage.window.title")
        window.minSize = NSSize(width: 850, height: 620)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("QuotaPieUsageAnalysis")
        window.contentViewController = NSHostingController(rootView: UsageWindowView(model: model, local: local, official: official, presentation: presentation))
        window.delegate = self
        window.center()
    }

    required init?(coder: NSCoder) { nil }

    func present() {
        if window?.isVisible != true { presentation.revision += 1 }
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func refreshReport() {
        if presentation.section != 1 { local.load(client: model.statusClient, actionToken: model.payload?.actionToken, refresh: true) }
        if presentation.section != 2 { official.load(client: model.statusClient, actionToken: model.payload?.actionToken, days: official.selectedDays, refresh: true) }
    }

    func windowWillClose(_ notification: Notification) {
        local.stop()
        official.stop()
    }
}

private struct UsageWindowView: View {
    @ObservedObject var model: PopoverModel
    @ObservedObject var local: UsageReportStore
    @ObservedObject var official: OfficialUsageStore
    @ObservedObject var presentation: UsageWindowPresentation

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("QuotaPie").font(.headline).foregroundStyle(.secondary)
                Spacer()
                Picker("", selection: $presentation.section) {
                    Text(Strings.t("usage.consumption.overview")).tag(0)
                    Text(Strings.t("usage.window.official")).tag(1)
                    Text(Strings.t("usage.window.local")).tag(2)
                }.pickerStyle(.segmented).frame(width: 380)
            }.padding(.horizontal, 24).padding(.vertical, 14)
            Divider()
            ScrollView {
                Group {
                    if presentation.section == 0 {
                        UsageConsumptionView(local: local, official: official, client: model.statusClient, actionToken: model.payload?.actionToken, accounts: model.payload?.accounts ?? [])
                    } else if presentation.section == 2 {
                        UsageReportView(store: local, client: model.statusClient, actionToken: model.payload?.actionToken,
                                        accounts: model.payload?.accounts ?? [])
                    } else {
                        OfficialUsageView(store: official, client: model.statusClient, actionToken: model.payload?.actionToken,
                                          accounts: model.payload?.accounts ?? [])
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(28)
            }
        }.frame(minWidth: 800, minHeight: 550)
        .onChange(of: presentation.revision) { _ in
            if presentation.section != 1 { local.load(client: model.statusClient, actionToken: model.payload?.actionToken) }
            if presentation.section != 2 { official.load(client: model.statusClient, actionToken: model.payload?.actionToken, days: official.selectedDays) }
        }
    }
}

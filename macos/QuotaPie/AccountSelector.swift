import AppKit
import SwiftUI

/// SwiftUI's Menu does not forward focusEffectDisabled to its AppKit cell.
/// Keep selection in SwiftUI and configure only the native menu presentation here.
struct AccountSelector: NSViewRepresentable {
    let accounts: [AccountState]
    let selectedID: String?
    let onSelect: (AccountState) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSPopUpButton {
        let button = NSPopUpButton(frame: .zero, pullsDown: true)
        button.identifier = NSUserInterfaceItemIdentifier("account-selector")
        button.isBordered = false
        button.focusRingType = .none
        button.font = .systemFont(ofSize: 13, weight: .medium)
        button.cell?.lineBreakMode = .byTruncatingMiddle
        button.setAccessibilityLabel(Strings.t("overview.chooseAccount"))
        return button
    }

    func updateNSView(_ button: NSPopUpButton, context: Context) {
        context.coordinator.accounts = accounts
        context.coordinator.onSelect = onSelect
        let selected = accounts.first { $0.id == selectedID }
        let menu = NSMenu()
        menu.addItem(withTitle: selected?.accountLabel ?? "QuotaPie", action: nil, keyEquivalent: "")
        for (index, account) in accounts.enumerated() {
            let item = NSMenuItem(title: "\(account.providerTitle) · \(account.accountLabel)",
                                  action: #selector(Coordinator.choose(_:)), keyEquivalent: "")
            item.target = context.coordinator
            item.tag = index
            item.state = account.id == selectedID ? .on : .off
            menu.addItem(item)
        }
        button.menu = menu
        button.toolTip = selected.map { "\($0.providerTitle) · \($0.accountLabel)" }
        button.setAccessibilityValue(selected?.accountLabel)
    }

    final class Coordinator: NSObject {
        var accounts: [AccountState] = []
        var onSelect: ((AccountState) -> Void)?
        @objc func choose(_ sender: NSMenuItem) {
            guard accounts.indices.contains(sender.tag) else { return }
            onSelect?(accounts[sender.tag])
        }
    }
}

import AppKit
import SwiftUI

/// The button title is independent of the menu: every menu row is an account.
struct AccountSelector: NSViewRepresentable {
    let accounts: [AccountState]
    let selectedID: String?
    let onSelect: (AccountState) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> AccountMenuButton {
        let button = AccountMenuButton(frame: .zero)
        button.identifier = NSUserInterfaceItemIdentifier("account-selector")
        button.isBordered = false
        button.focusRingType = .none
        button.font = .systemFont(ofSize: 13, weight: .medium)
        button.alignment = .left
        button.cell?.lineBreakMode = .byTruncatingMiddle
        button.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)
        button.imagePosition = .imageTrailing
        button.setAccessibilityLabel(Strings.t("overview.chooseAccount"))
        button.target = context.coordinator
        button.action = #selector(Coordinator.open(_:))
        return button
    }

    func updateNSView(_ button: AccountMenuButton, context: Context) {
        context.coordinator.accounts = accounts
        context.coordinator.selectedID = selectedID
        context.coordinator.onSelect = onSelect
        let selected = accounts.first { $0.id == selectedID }
        button.title = selected?.accountLabel ?? "QuotaPie"
        button.toolTip = selected.map { "\($0.providerTitle) · \($0.accountLabel)" }
        button.setAccessibilityValue(selected?.accountLabel)
        // Do not replace a menu while AppKit is tracking a user's selection.
        // Build a fresh snapshot only when the button is activated.
    }

    final class Coordinator: NSObject {
        var accounts: [AccountState] = []
        var selectedID: String?
        var onSelect: ((AccountState) -> Void)?

        func makeMenu() -> NSMenu {
            let menu = NSMenu()
            for account in accounts {
                let item = NSMenuItem(title: "\(account.providerTitle) · \(account.accountLabel)",
                                      action: #selector(choose(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = account.id
                item.state = account.id == selectedID ? .on : .off
                menu.addItem(item)
            }
            return menu
        }

        @objc func open(_ sender: NSButton) {
            makeMenu().popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.minY), in: sender)
        }

        @objc func choose(_ sender: NSMenuItem) {
            guard let id = sender.representedObject as? String,
                  let account = accounts.first(where: { $0.id == id }) else { return }
            onSelect?(account)
        }
    }
}

final class AccountMenuButton: NSButton {
    // A menu-bar popover need not be the key window when first clicked.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

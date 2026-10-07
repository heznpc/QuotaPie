import AppKit
import XCTest
@testable import QuotaPie

final class AccountSelectorTests: XCTestCase {
    func testMenuContainsOnlyAccountsAndSelectionSurvivesRefreshReordering() {
        let coordinator = AccountSelector.Coordinator()
        let first = account("first"), second = account("second")
        coordinator.accounts = [first, second]
        coordinator.selectedID = first.id
        var selections: [String] = []
        coordinator.onSelect = { selections.append($0.id) }
        let menu = coordinator.makeMenu()
        XCTAssertEqual(menu.items.map(\.title), ["Codex · first", "Codex · second"])
        XCTAssertEqual(menu.items.map(\.state), [.on, .off])
        XCTAssertTrue(menu.items.allSatisfy { !$0.isHidden && $0.action != nil })
        // A status refresh may reorder accounts while the menu is open.
        coordinator.accounts = [second, first]
        coordinator.choose(menu.items[1])
        XCTAssertEqual(selections, [second.id])
        // Removed accounts must never select a replacement occupying their index.
        coordinator.accounts = [first]
        coordinator.choose(menu.items[1])
        XCTAssertEqual(selections, [second.id])
    }

    private func account(_ id: String) -> AccountState {
        AccountState(provider: "codex", account: id, accountLabel: id, enabled: true,
                     collection: CollectionState(health: "recent-success", activeSource: nil, lastSuccessAtMs: nil,
                                                 errorCategory: nil, errorDetail: nil),
                     windows: [], bottleneckBucket: nil, updatedAtMs: nil)
    }
}

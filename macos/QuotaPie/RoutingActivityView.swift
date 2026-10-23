import SwiftUI

struct RoutingSummaryButton: View {
    @ObservedObject var model: PopoverModel
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.branch").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: 12, weight: .medium)).lineLimit(1).truncationMode(.middle)
                    Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 10)
                .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("routing.summary")
    }

    private var title: String {
        if let account = model.menuAccount, !model.currentRoutes.isEmpty {
            return Strings.t("routing.processing", account.accountLabel)
        }
        if let title = model.concurrentRoutingTitle { return title }
        return Strings.t("routing.title")
    }

    private var detail: String {
        if model.lastError != nil || model.showingStartupCache || model.payload?.routing?.activityUncertain == true { return Strings.t("routing.unavailable") }
        if let route = model.currentRoutes.first, model.menuAccount != nil, route.hasVerifiedAccount {
            return route.switched == true ? Strings.t("routing.switched", route.routeLabel(in: model.enabledAccounts)) : Strings.t("routing.source")
        }
        if !model.currentRoutes.isEmpty { return Strings.t("routing.concurrent", String(model.currentRoutes.count)) }
        if let recent = model.payload?.routing?.recent.first {
            return Strings.t("routing.last", recent.accountLabel(in: model.enabledAccounts))
        }
        return Strings.t("routing.waiting")
    }
}

struct RoutingActivityView: View {
    @ObservedObject var model: PopoverModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Strings.t("routing.title")).font(.headline)
            Text(Strings.t("routing.explanation")).font(.caption).foregroundStyle(.secondary)
            if model.lastError != nil || model.showingStartupCache || model.payload?.routing?.isCurrent() != true || model.payload?.routing?.activityUncertain == true {
                Label(Strings.t("routing.unavailable"), systemImage: "clock").font(.caption).foregroundStyle(.secondary)
            }
            if !model.currentRoutes.isEmpty {
                Text(Strings.t("routing.active")).font(.subheadline.weight(.medium))
                ForEach(model.currentRoutes.prefix(8)) { route in row(route) }
                if model.currentRoutes.count > 8 {
                    Text(Strings.t("routing.more", String(model.currentRoutes.count - 8))).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let recent = model.payload?.routing?.recent, !recent.isEmpty {
                Text(Strings.t("routing.recent")).font(.subheadline.weight(.medium))
                ForEach(recent.prefix(8)) { route in row(route) }
            } else if model.currentRoutes.isEmpty {
                Text(Strings.t("routing.waiting")).font(.callout).foregroundStyle(.secondary)
            }
        }.accessibilityIdentifier("routing.activity")
    }

    private func row(_ route: RequestRoute) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Label(route.routeLabel(in: model.enabledAccounts), systemImage: route.switched == true ? "arrow.right" : "person.crop.circle")
                    .font(.system(size: 12, weight: .medium)).textSelection(.enabled)
                Spacer(minLength: 4)
                if route.observedAtMs.isFinite, route.observedAtMs > 0 {
                    Text(Date(timeIntervalSince1970: route.observedAtMs / 1000), style: .time)
                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            if route.upstreamResponseObserved != true, route.hasKnownAccount {
                Text(Strings.t("routing.targetOnly")).font(.caption2).foregroundStyle(.secondary)
            }
            Text(route.detailText).font(.caption).foregroundStyle(.secondary)
            if let thread = route.threadId {
                Text(Strings.t("routing.thread", String(thread.prefix(8))))
                    .font(.caption2.monospaced()).foregroundStyle(.tertiary).help(thread)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 3)
    }
}

struct CreditUsageView: View {
    let credits: CreditUsage
    var current = true

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(Strings.t("credits.title")).font(.subheadline.weight(.medium))
                Spacer()
                Text(credits.decreaseText).font(.system(size: 16, weight: .medium).monospacedDigit())
            }
            Text(Strings.t("credits.interval")).font(.caption).foregroundStyle(.secondary)
            if let balance = credits.balance, balance.isFinite, balance >= 0 {
                Text(Strings.t("credits.balance", CreditUsage.amount(balance))).font(.caption).foregroundStyle(.secondary)
            }
            if !current || !credits.isCurrent() {
                Text(Strings.t("credits.previous")).font(.caption).foregroundStyle(.secondary)
            } else if credits.lastHour.coverage == "partial" {
                Text(Strings.t("credits.partial")).font(.caption2).foregroundStyle(.secondary)
            } else if credits.lastHour.coverage == "unknown" {
                Text(Strings.t("credits.waiting")).font(.caption2).foregroundStyle(.secondary)
            }
            if let increase = credits.lastHour.observedIncrease, increase.isFinite, increase > 0 {
                Text(Strings.t("credits.increase", CreditUsage.amount(increase))).font(.caption2).foregroundStyle(.secondary)
            }
            Text(Strings.t("credits.scope")).font(.caption2).foregroundStyle(.secondary)
        }.accessibilityIdentifier("credits.usage")
    }
}

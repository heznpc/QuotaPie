import SwiftUI

struct AccountPoolSettingsView: View {
    @ObservedObject var model: PopoverModel
    let save: (Bool?, String?, Int?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Strings.t("pool.settings.title")).font(.headline)
            if let pool = model.payload?.accountPool, pool.accounts.count >= 2 {
                Toggle(Strings.t("pool.settings.enabled"), isOn: Binding(
                    get: { pool.enabled }, set: { save($0, nil, nil) }
                )).toggleStyle(.switch)
                Text(Strings.t("pool.settings.explanation")).font(.callout).foregroundStyle(.secondary)
                ForEach(pool.accounts, id: \.self) { id in
                    let label = model.payload?.accounts.first { $0.provider == "codex" && $0.account == id }?.accountLabel ?? id
                    let reserve = pool.reservePercent?[id] ?? 0
                    VStack(alignment: .leading, spacing: 4) {
                        Stepper(value: Binding(get: { reserve }, set: { save(nil, id, $0) }), in: 0...100, step: 5) {
                            HStack {
                                Text(label).lineLimit(1)
                                Spacer()
                                Text(Strings.t("pool.settings.reserve", String(reserve))).monospacedDigit()
                            }
                        }.accessibilityLabel(Strings.t("pool.settings.accountReserve", label))
                        Text(Strings.t(reserve == 0 ? "pool.settings.zero" : "pool.settings.usage", String(100 - reserve)))
                            .font(.caption).foregroundStyle(.secondary)
                    }.disabled(!pool.enabled)
                }
                Text(Strings.t("pool.settings.whenBlocked")).font(.caption).foregroundStyle(.secondary)
                Text(Strings.t("pool.settings.limits")).font(.caption).foregroundStyle(.secondary)
                Text(Strings.t("pool.settings.upgrade")).font(.caption).foregroundStyle(.secondary)
                if pool.recent.first?.reason == "reserve" {
                    Text(Strings.t("pool.settings.switched")).font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Text(Strings.t("pool.settings.unavailable")).font(.callout).foregroundStyle(.secondary)
            }
            if let pool = model.payload?.accountPool, let rejected = pool.rejected, !rejected.isEmpty {
                Divider()
                Text(Strings.t("pool.history.title")).font(.subheadline)
                if let unresolved = pool.unresolvedRejections {
                    Text(Strings.t("pool.history.unresolved", String(unresolved.count)))
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(rejected) { request in
                    let label = model.payload?.accounts.first { $0.provider == "codex" && $0.account == request.sourceAccount }?.accountLabel ?? request.sourceAccount
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Strings.t("pool.history.request", label,
                            Date(timeIntervalSince1970: request.atMs / 1000).formatted(date: .abbreviated, time: .standard)))
                        Text(Strings.t(request.reasonKey))
                        Text(Strings.t(request.recovered == true ? "pool.history.recovered" : "pool.history.unverified"))
                            .foregroundStyle(.secondary)
                    }.font(.caption).help(request.code)
                }
            }
            if let message = model.poolSaveMessage { Text(message).font(.caption).foregroundStyle(.secondary) }
        }
        .disabled(model.poolSaving || model.payload?.actionToken == nil || model.lastError != nil)
    }
}

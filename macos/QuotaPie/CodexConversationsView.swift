import SwiftUI
import AppKit

struct CodexConversationsView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: CodexConversationsModel
    let token: String
    let label: String
    init(account: String, label: String, token: String) {
        _model = StateObject(wrappedValue: CodexConversationsModel(account: account))
        self.label = label; self.token = token
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(Strings.t("conversations.title", label)).font(.headline)
                Spacer()
                Button(Strings.t("conversations.close")) { dismiss() }.keyboardShortcut(.cancelAction)
            }
            Text(Strings.t("conversations.explanation")).font(.callout).foregroundStyle(.secondary)
            if model.loading { ProgressView().controlSize(.small) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 3) {
                    if model.conversations.isEmpty && !model.loading {
                        Text(Strings.t("conversations.empty")).font(.callout).foregroundStyle(.secondary).padding(7)
                    }
                    ForEach(model.conversations) { conversation in
                        Button { model.selectedID = conversation.id } label: {
                            HStack {
                                Image(systemName: model.selectedID == conversation.id ? "checkmark.circle.fill" : "circle")
                                Text(conversation.displayTitle).lineLimit(2).multilineTextAlignment(.leading)
                                Spacer()
                                if conversation.active == true { Text(Strings.t("conversations.active")).font(.caption) }
                            }.padding(7).frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.plain).disabled(model.pending || model.sending)
                        .background(model.selectedID == conversation.id ? Color.accentColor.opacity(0.12) : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    if model.nextCursor != nil {
                        Button(Strings.t("conversations.more")) { Task { await model.load(token: token, more: true) } }
                            .disabled(model.loading)
                    }
                }
            }.frame(height: 220)
            Text(Strings.t("conversations.message")).font(.callout.weight(.medium))
            TextEditor(text: $model.draft).font(.body).frame(height: 95).border(Color.secondary.opacity(0.3))
                .disabled(model.pending || model.sending)
                .accessibilityIdentifier("conversations.message")
            if let receipt = model.receipt {
                Label(Strings.t("conversations.state." + receipt.state), systemImage: receipt.state == "completed" ? "checkmark.circle" : "clock")
                    .font(.callout).foregroundStyle(receipt.state == "failed" ? Color.orange : Color.secondary)
            }
            if let error = model.error { Text(error).font(.callout).foregroundStyle(.orange) }
            if let explanation = model.receiptExplanation { Text(explanation).font(.callout).foregroundStyle(.orange) }
            HStack {
                if model.pending && model.error != nil {
                    Button(Strings.t("conversations.recheck")) { Task { await model.recheckSubmission(token: token) } }
                        .disabled(!model.canRecheck)
                }
                Button(Strings.t("action.refresh")) { Task { await model.load(token: token); await model.refreshReceipt(token: token) } }
                    .disabled(model.loading || model.sending)
                Button(Strings.t("conversations.open")) {
                    if let id = model.selectedID, UUID(uuidString: id) != nil,
                       let url = URL(string: "codex://threads/" + id) { NSWorkspace.shared.open(url) }
                }.disabled(model.selectedID == nil)
                Spacer()
                Button(Strings.t("conversations.send")) { Task { await model.send(token: token) } }
                    .buttonStyle(.borderedProminent).disabled(!model.canSend)
                    .accessibilityIdentifier("conversations.send")
            }
        }.padding(20).frame(width: 540)
        .onDisappear { model.saveDraft() }
        .task {
            await model.load(token: token)
            while !Task.isCancelled {
                await model.refreshReceipt(token: token)
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }
}

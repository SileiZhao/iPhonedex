import Foundation
import UIKit
import UserNotifications

final class MonitorNotificationService {
    @MainActor
    func requestRemoteNotificationRegistration() async -> Bool {
        guard await requestAuthorizationIfNeeded() else { return false }
        UIApplication.shared.registerForRemoteNotifications()
        return true
    }

    static func hexString(from deviceToken: Data) -> String {
        deviceToken.map { String(format: "%02x", $0) }.joined()
    }

    func notifyAttention(snapshot: ThreadSnapshot) async {
        guard await requestAuthorizationIfNeeded() else { return }

        let content = UNMutableNotificationContent()
        content.sound = .default
        content.title = snapshot.status == .waitingForApproval ? "Codex 等待批准" : "Codex 任务失败"
        content.body = "\(snapshot.title) · \(snapshot.hostId)"
        content.threadIdentifier = snapshot.threadId

        let request = UNNotificationRequest(
            identifier: "codex-\(snapshot.threadId)-\(snapshot.status.rawValue)-\(snapshot.lastEventAt)",
            content: content,
            trigger: nil
        )

        try? await UNUserNotificationCenter.current().add(request)
    }

    private func requestAuthorizationIfNeeded() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined:
            return (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        case .denied:
            return false
        @unknown default:
            return false
        }
    }
}

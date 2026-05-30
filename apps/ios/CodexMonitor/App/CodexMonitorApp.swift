import SwiftUI
import UIKit
import UserNotifications

@main
struct CodexMonitorApp: App {
    @UIApplicationDelegateAdaptor(MonitorAppDelegate.self) private var appDelegate

    init() {
        MonitorNotificationService().configureNotificationCategories()
        UNUserNotificationCenter.current().delegate = ForegroundNotificationDelegate.shared
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

final class MonitorAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        NotificationCenter.default.post(
            name: .codexMonitorDeviceTokenReceived,
            object: MonitorNotificationService.hexString(from: deviceToken)
        )
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        NotificationCenter.default.post(
            name: .codexMonitorDeviceTokenRegistrationFailed,
            object: error.localizedDescription
        )
    }
}

final class ForegroundNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = ForegroundNotificationDelegate()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        []
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let action: ApprovalAction
        switch response.actionIdentifier {
        case MonitorNotificationService.approveActionIdentifier:
            action = .approve
        case MonitorNotificationService.rejectActionIdentifier:
            action = .reject
        default:
            return
        }

        let userInfo = response.notification.request.content.userInfo
        guard
            let hostId = userInfo["hostId"] as? String,
            let threadId = userInfo["threadId"] as? String,
            let approvalId = userInfo["approvalId"] as? String
        else {
            return
        }
        let commandPreview = userInfo["commandPreview"] as? String ?? ""

        do {
            let configuration = try ConfigurationStore().load()
            guard let url = URL(string: configuration.serverURL) else { return }
            let client = MonitorClient(baseURL: url, token: configuration.mobileToken)
            try await client.sendApprovalAction(
                hostId: hostId,
                threadId: threadId,
                cwd: nil,
                approvalId: approvalId,
                action: action,
                commandPreview: commandPreview
            )
        } catch {
            return
        }
    }
}

extension Notification.Name {
    static let codexMonitorDeviceTokenReceived = Notification.Name("codexMonitorDeviceTokenReceived")
    static let codexMonitorDeviceTokenRegistrationFailed = Notification.Name("codexMonitorDeviceTokenRegistrationFailed")
}

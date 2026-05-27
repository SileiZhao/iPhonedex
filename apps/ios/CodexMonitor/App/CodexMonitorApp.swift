import SwiftUI
import UIKit
import UserNotifications

@main
struct CodexMonitorApp: App {
    @UIApplicationDelegateAdaptor(MonitorAppDelegate.self) private var appDelegate

    init() {
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
        [.banner, .sound, .list]
    }
}

extension Notification.Name {
    static let codexMonitorDeviceTokenReceived = Notification.Name("codexMonitorDeviceTokenReceived")
    static let codexMonitorDeviceTokenRegistrationFailed = Notification.Name("codexMonitorDeviceTokenRegistrationFailed")
}

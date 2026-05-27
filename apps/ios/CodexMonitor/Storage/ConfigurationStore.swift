import Foundation
import Security

struct MonitorConfiguration: Equatable {
    var serverURL: String
    var mobileToken: String
}

enum ConfigurationStoreError: Error {
    case invalidData
    case keychainStatus(OSStatus)
}

final class ConfigurationStore {
    static let defaultServerURL = "https://monitor.example.com"

    private let service = "CodexMonitor"
    private let tokenAccount = "mobile-token"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() throws -> MonitorConfiguration {
        let serverURL = defaults.string(forKey: "monitor.serverURL") ?? Self.defaultServerURL
        return MonitorConfiguration(serverURL: serverURL, mobileToken: try loadToken())
    }

    func save(_ configuration: MonitorConfiguration) throws {
        defaults.set(configuration.serverURL, forKey: "monitor.serverURL")
        try saveToken(configuration.mobileToken)
    }

    func clear() throws {
        defaults.removeObject(forKey: "monitor.serverURL")
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            throw ConfigurationStoreError.keychainStatus(status)
        }
    }

    private func loadToken() throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return ""
        }
        guard status == errSecSuccess else {
            throw ConfigurationStoreError.keychainStatus(status)
        }
        guard let data = item as? Data, let token = String(data: data, encoding: .utf8) else {
            throw ConfigurationStoreError.invalidData
        }
        return token
    }

    private func saveToken(_ token: String) throws {
        let data = Data(token.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        if updateStatus != errSecItemNotFound {
            throw ConfigurationStoreError.keychainStatus(updateStatus)
        }

        var addQuery = query
        addQuery[kSecValueData as String] = data
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw ConfigurationStoreError.keychainStatus(addStatus)
        }
    }
}

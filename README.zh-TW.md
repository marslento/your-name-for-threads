# Your Name for Threads

[English](README.md) | 繁體中文

本機優先、開源的 Threads 私人暱稱與備註通訊錄。

在 Threads 個人頁、動態消息、回覆與引用貼文中顯示自己設定的暱稱，也能在擴充功能的通訊錄管理頁面（Dashboard）保存私人備註，搜尋、編輯及備份資料。不同 Threads 帳號在這個瀏覽器中各有自己的通訊錄。

1.0.0 版已於 Chrome Web Store 與 Microsoft Edge Add-ons 上架。已記錄的驗證結果與待完成項目，請見[發布驗證狀態](docs/verification/current-status.md)。

## 隱私

- 暱稱與備註儲存在這個瀏覽器中，由擴充功能在本機處理，不會自動傳送給開發者。
- 本專案沒有接收這些資料的後端服務，也沒有雲端同步。不做分析、使用行為追蹤、自動當機回報或廣告追蹤。
- 擴充功能僅要求 `storage` 儲存權限，以及 `https://www.threads.com/*` 的網站存取權限。

詳細說明請見[隱私權政策](PRIVACY.md)與[資料處理對照表](docs/privacy/data-handling-matrix.md)。

## 支援瀏覽器

最新穩定版 Chrome 與 Edge。其他以 Chromium 為基礎的瀏覽器不在正式支援範圍內。

## 安裝

- [從 Chrome Web Store 安裝](https://chromewebstore.google.com/detail/your-name-for-threads/jmpaegbcheebaflefpfappfbiimgknoa)
- [從 Microsoft Edge Add-ons 安裝](https://microsoftedge.microsoft.com/addons/detail/your-name-for-threads/ojnkchiogffjbniepbngfokiapfahmpb)

安裝後，將 Your Name for Threads 釘選到工具列，開啟擴充功能並完成初次使用導覽。登入 Threads，前往他人的個人頁，選擇「添加暱稱」。在該 Threads 分頁開啟擴充功能，再選擇「開啟通訊錄」，即可管理資料。

## 從原始碼安裝

需要 Git、Node.js 24，以及 `package.json` 指定的 pnpm 10.22.0。下載原始碼並建置擴充功能：

```bash
git clone https://github.com/marslento/your-name-for-threads.git
cd your-name-for-threads
pnpm install --frozen-lockfile
pnpm build
```

在瀏覽器中載入建置結果：

1. 在 Chrome 開啟 `chrome://extensions`，或在 Edge 開啟 `edge://extensions`。
2. 開啟「開發人員模式」，選擇「載入未封裝項目」（Load unpacked），再選取建置產生的 `dist` 資料夾。
3. 將 **Your Name for Threads** 釘選到工具列，開啟擴充功能並完成初次使用導覽。
4. 登入 Threads，前往他人的個人頁，選擇「添加暱稱」。
5. 在該 Threads 分頁開啟擴充功能，選擇「開啟通訊錄」，即可管理暱稱、備註與備份。

使用通訊錄管理頁面時，請保留原本開啟它的 Threads 分頁。重新整理、關閉或離開該來源頁面，會結束通訊錄工作階段，未儲存的變更也會遺失。請從已確認登入帳號的 Threads 分頁重新開啟通訊錄。

開發指令與驗證方式請見[貢獻指南](CONTRIBUTING.md)及[測試指南](docs/testing.md)。

## 資料與備份限制

- 解除安裝擴充功能或刪除瀏覽器設定檔（Profile）前，請先匯出 JSON 備份。本專案沒有可供還原的雲端副本。
- 備份檔未加密，內含私人備註、暱稱與識別資訊，請妥善保管，不要公開張貼。
- 若帳號資料受損，請保留修復頁面匯出的復原檔。單一帳號的復原檔必須每筆紀錄都通過檢查，才能復原到該帳號的空通訊錄，或修復原本受損的通訊錄。下載成功不保證可還原，包含所有帳號資料的復原檔也無法復原。
- 各帳號通訊錄的區隔屬於功能上的區分，並不是共用同一個瀏覽器 Profile 的人之間的加密安全邊界。多人共用電腦時，請使用不同的瀏覽器 Profile 或作業系統帳號來隔離私人資料。
- 顯示在 Threads 頁面上的暱稱會成為頁面的一部分，該頁面的程式碼可以讀取。備註則留在擴充功能的通訊錄管理頁面中。詳細說明請見[安全邊界](docs/security/threat-model-v1.md)。

## 問題回報

遇到問題時，請透過 [GitHub 問題回報表單](https://github.com/marslento/your-name-for-threads/issues/new?template=bug_report.yml)描述發生的情況，並附上瀏覽器與擴充功能版本。也可以在通訊錄管理頁面選擇「關於與隱私 → 複製診斷資訊」，檢閱內容後再附上。請勿在公開 Issue 貼上私人暱稱、備註、完整 JSON 備份或復原匯出資料（Recovery export）。

若發現安全漏洞或隱私洩漏，請使用 [SECURITY.md](SECURITY.md) 中的私密回報管道，避免在公開 Issue 揭露。

## 文件

以下文件目前以英文為主：

- [隱私權政策](PRIVACY.md)：儲存與讀取哪些資料，以及哪些情況下資料可能離開瀏覽器
- [安全政策](SECURITY.md)：如何回報安全漏洞
- [貢獻指南](CONTRIBUTING.md)：建置、測試及修改程式時應遵守的規則
- [更新紀錄](CHANGELOG.md)：各版本的變更內容
- [專案文件](docs/README.md)：目前的架構、測試方式與發布驗證紀錄

## 關於本專案

這是一個獨立的開源專案。

本專案以 vibe coding 方式開發，開發過程使用 OpenAI 模型與 Claude Code 協助。

## 授權

採用 [MIT 授權](LICENSE)。Copyright (c) 2026 Marcia.

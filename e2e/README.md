# 擴充功能 Playwright 驗收

這組測試將 `dist` 的正式建置載入 Playwright 隨附的 Chromium。每個案例使用獨立的臨時瀏覽器資料，關閉後由 Playwright 清理。全部 HTTP(S) 頁面請求都由測試提供內容或攔截，不使用你已登入的 Chrome／Edge，也不需要 Threads 密碼。

## 執行

專案使用 Node.js 24 及 pnpm 10.22.0。首次安裝：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

重新建置、檢查 TypeScript，再驗收：

```sh
pnpm test:e2e
```

需要看操作過程時，先建置，再執行有視窗的版本：

```sh
pnpm build
pnpm exec playwright test --headed
```

檢視最近一輪報告：

```sh
pnpm test:e2e:report
```

報告位於 `playwright-report/index.html`。失敗時保存每個開啟頁面的截圖和 `trace.zip`，可在 HTML 報告中查看操作、畫面與錯誤。下載檔位於 `test-results`，只有模擬資料。測試不自動重試，失敗會直接列入結果。Git 已忽略這些輸出。

## 自動驗證範圍

| 案例 | 實際檢查 |
| --- | --- |
| 首次導覽 | 三步流程、開啟模擬 Threads、完成旗標在重新載入後仍有效 |
| 暱稱與備份 | Profile 表單儲存、feed 顯示、綁定正確帳號、Directory 顯示、Settings／About 頁面、下載 JSON、相同備份匯入完成、Done 返回、資料保持相同 |
| Recovery | 當前帳號資料損壞後隱藏名錄與私密內容；匯出保留原始資料且限於該帳號；取消清除不改資料；確認清除後回到名錄，另一帳號資料完整保留 |
| 網站範圍 | 瀏覽器讀到的 manifest 將兩支內容腳本限制在 Threads；其他網站沒有擴充 UI |
| Dashboard 來源生命週期（`dashboard-lifecycle.spec.ts`） | 重新載入（含新頁被網路擋住時）、離開 Threads、關閉來源、登出與換帳號、兩個來源同帳號、連按與同時開啟、站內導覽後仍可儲存、被導向他站的 Dashboard 分頁不被誤關、使用者自行關閉、開啟途中來源消失。重新載入尚未完成時，Popup 不可用舊頁證據開啟 Dashboard。等待中操作取消與訊息排序另由單元測試覆蓋；worker 重啟仍需實機驗證，Threads 強制重新整理提示辨識尚未支援。 |

資料損壞直接寫入此案例的臨時 `chrome.storage.local`，其他操作使用真正的擴充功能 UI 和下載。Dashboard 使用 Popup 原本送給背景的訊息（`tpd:open-dashboard`）：背景從模擬 Threads 分頁已確認的帳號開啟 Dashboard 分頁；沒有偽造帳號權限。生命週期案例可用 `?as=none`（登出後的文件）、`?as=other`（另一帳號）、`?hydrate=<毫秒>`（延後才出現帳號資料）控制模擬頁面，並可暫扣 Threads 文件回應，讓重新載入停在網路上。

## 仍需真實瀏覽器／人工驗證

- 最新 Chrome／Edge 的安裝、權限提示、工具列 Popup 開關與焦點。
- 真實 Threads 的 DOM、捲動、路由切換、回覆／引用、登入／登出與多帳號切換。
- NVDA、系統縮放、剪貼簿、各語系排版、長時間使用與效能。
- 有差異的備份合併／還原、衝突處理，以及原人工驗收表的其他項目。

這組測試使用建置目錄。送審前仍需執行[最終 ZIP 檢查](../scripts/verification/final-zip-smoke/README.md)與[人工瀏覽器驗收](../docs/manual-acceptance.md)。模擬頁面通過不代表當下的 Threads 網站已驗收。

CI 已設定使用相同命令，安裝 Chromium 並上傳 HTML 報告；是否在 GitHub 上通過，須以實際 CI 執行結果為準。

設計依循 [Playwright 官方擴充功能測試方式](https://playwright.dev/docs/chrome-extensions)：使用獨立的 persistent context 和隨附 Chromium。

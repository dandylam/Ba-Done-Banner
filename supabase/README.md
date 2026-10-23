# 客戶專區設定（Supabase）

客戶專區 `portal.html` 及管理後台 `admin.html` 使用 [Supabase](https://supabase.com)（免費計劃）處理登入、訂單資料及檔案儲存。

## 功能

| 客戶（/portal.html） | 巴登（/admin.html） |
|---|---|
| 用電郵註冊／登入、忘記密碼 | 睇晒所有訂單，按狀態篩選、搜尋 |
| 建立訂單：揀製作類型、尺寸、數量、物料、安裝、完成日期 | 下載客戶設計稿 |
| 上傳設計稿（每個最多 50MB，每次最多 10 個） | 上傳確認稿（JPG / PNG / PDF），客戶會收到「待確認」 |
| 睇確認稿 → 按「確認稿件」或「要求修改」（寫意見） | 睇到客戶意見，再上傳新一稿 |
| 隨時睇返過往訂單、狀態、稿件同發票 | 上傳發票、更改訂單狀態、WhatsApp 通知客戶 |

訂單狀態：已提交 → 稿件待確認 →（要求修改 → 稿件待確認）→ 稿件已確認 → 製作中 → 已完成

## 一次性設定（約 10 分鐘）

1. 去 <https://supabase.com> 用 print@e8done.com 註冊，New project（Region 揀 Singapore 或 Tokyo，較接近香港）。
2. 左邊 **SQL Editor** → New query → 貼上 `supabase/schema.sql` 全部內容 → **Run**。
3. **Project Settings → API**：複製 `Project URL` 同 `anon public` key，填入 `assets/portal/config.js`：
   ```js
   SUPABASE_URL: 'https://xxxx.supabase.co',
   SUPABASE_ANON_KEY: 'eyJhbGciOi...',
   ```
   anon key 本身係公開用，可以放喺網頁；資料安全由 `schema.sql` 入面嘅權限規則（RLS）保障：客戶只睇到自己嘅訂單，唔可以改狀態或上傳確認稿／發票。
   **千萬唔好**將 `service_role` key 放入網頁。
4. **Authentication → URL Configuration**：
   - Site URL：`https://e8done.com`
   - Redirect URLs 加入：`https://e8done.com/portal.html`、`https://e8done.com/portal`、`https://e8done.com/admin.html`、`https://e8done.com/admin`
5. 設定管理員：去 `https://e8done.com/portal.html` 用你自己嘅電郵註冊並確認，然後喺 SQL Editor 執行：
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'print@e8done.com';
   ```
   之後用同一個帳戶登入 `https://e8done.com/admin.html`。
6. （建議）**Authentication → Emails**：將確認電郵／重設密碼電郵改成中文。免費計劃內置電郵每小時只可寄幾封，客戶多嘅話喺 **Authentication → SMTP Settings** 設定自己嘅郵件伺服器（例如公司 email 或 Resend）。

## 注意

- 免費計劃：500MB 資料庫、1GB 檔案儲存；一星期冇人用會暫停（登入 Supabase 按 Restore 即可）。設計稿多嘅話考慮 Pro 計劃（US$25/月，100GB）。
- 管理後台網址唔會出現喺主頁，亦設定咗唔被搜尋器收錄；就算有人知道網址，冇管理員權限都睇唔到任何資料。
- 新訂單唔會自動電郵通知；客戶提交後頁面會提供「WhatsApp 通知巴登」按鈕，你亦可以每日睇後台「需要跟進」嘅訂單。

# 可用技能

## check-email
查詢 Gmail 未讀信件，支援手動查詢和排程通知模式

參數:
  - `mode`: 查詢模式：manual（手動）、scheduled（排程）、notify（主動推送）
  - `chatId`: Telegram chat ID（notify 模式必填）

## create-order
建立 ERP 訂單（解析用戶輸入 → 查客戶 → 確認 → 建單）

參數:
  - `customerName`: 客戶名稱
  - `items`: 品項列表 [{name, quantity, price}]
  - `address`: 送貨地址
  - `note`: 訂單備註
  - `message`: 自然語言訂單描述（會自動解析）

## generate-pdf
從 ERP 訂單生成 PDF 單據（報價單/採購單/銷貨單）

參數:
  - `orderNumber`: 訂單編號（例如 ORD-260123-SA7M）
  - `type`: 單據類型

## print-label
透過精臣標籤機列印標籤（文字、條碼、QR Code、產品標籤）

參數:
  - `text`: 標籤文字內容
  - `barcode`: 條碼內容
  - `qrcode`: QR Code 內容
  - `copies`: 列印份數
  - `productNo`: ERP 品號（產品標籤模式）
  - `mode`: 標籤模式

## set-reminder
設定提醒事項（單次或重複）

參數:
  - `content`: 提醒內容
  - `remindAt`: ISO 8601 日期時間
  - `repeat`: 重複類型
  - `weekdays`: 週幾（逗號分隔，0=日 1=一 ...）
  - `dayOfMonth`: 每月幾號
  - `intervalMs`: 間隔毫秒數

## system-router
意圖路由器 — 分派意圖到對應 skill（email、erp、reminder、query、chat）

參數:
  - `type`: 意圖類型
  - `params`: 意圖參數

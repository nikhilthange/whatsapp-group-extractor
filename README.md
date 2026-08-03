# 📱 WhatsApp Group Contact Extractor & Excel / CSV Dashboard

An automated Node.js tool powered by [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) that authenticates via QR code, lists all your WhatsApp groups, and exports participants (Phone Number, Name, Admin Status, JID) directly to **Excel (.xlsx)** and CSV files. Includes an interactive Web Dashboard to view, filter, and manage exported contact files.

---

## ✨ Features

- 🔐 **Local Authentication**: Uses `LocalAuth` to store session data locally in `./.wwebjs_auth`. QR code only needed on first login.
- 📋 **Group Listing**: Displays all active group chats along with total participant counts.
- 🎯 **Interactive Group Selection**: Choose a single group, multiple groups, or export **all groups at once**.
- 📊 **Native Excel (.xlsx) Export**: Formatted spreadsheets with custom column widths (`PHONE_NUMBER`, `NAME`, `IS_ADMIN`, `USER_JID`).
- 🌐 **Web Dashboard (`index.html`)**: Drag & drop your exported `.xlsx` or `.csv` files to filter by Admin status, search contacts, copy numbers to clipboard, export custom `.xlsx` spreadsheets, or export `.vcf` (vCard) files for phone import!

---

## 🚀 Quick Start

### 1. Installation

Ensure Node.js is installed on your computer. Open terminal in this directory and run:

```bash
npm install
```

### 2. Run the Extractor

```bash
npm start
```
or
```bash
node extractContacts.js
```

### 3. Pair WhatsApp

1. A QR code will display in your terminal.
2. Open WhatsApp on your phone $\rightarrow$ **Settings / Linked Devices** $\rightarrow$ **Link a Device**.
3. Scan the terminal QR code.
4. Select the group you want to export (or enter `A` to export all groups).
5. The extracted **Excel (.xlsx)** file will be saved in your project root folder (e.g. `whatsapp_Group_Name_contacts.xlsx`).

---

## 💻 Web Contact Dashboard (`index.html`)

Double-click `index.html` or open it in any web browser to:
- Drag & drop your generated `.xlsx` or `.csv` files.
- Search contacts by Name or Phone Number.
- Filter between **Admins** and **Members**.
- Copy all phone numbers to clipboard with one click.
- Export filtered lists directly to **Excel (.xlsx)**.
- Export contacts directly to **.vcf (vCard)** files to import into iOS / Android contacts.

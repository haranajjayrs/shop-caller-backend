# Shop Caller backend v2 (Node/Express + DynamoDB + Firebase Auth)

All business data lives in **AWS DynamoDB**. Firebase is used **only** to log users in
(the backend verifies Firebase ID tokens and creates salesman logins with the Admin SDK).

## 1. Firebase
1. Firebase console → your project → Authentication → enable **Email/Password**.
2. Project settings → Service accounts → **Generate new private key**.
3. `base64 -w0 serviceAccount.json` → paste into `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64`.

## 2. AWS
1. IAM user (or role) with DynamoDB access to the 4 tables below (+ their indexes).
2. `cp .env.example .env` and fill it in.
3. `npm install && npm run create-tables` — creates (on-demand billing):

| Table | Key | GSIs |
|---|---|---|
| SC_Companies | companyId | – |
| SC_Users | uid | companyId-index |
| SC_Shops | shopId | companyId-index, salesmanUid-index |
| SC_CallLogs | callId | companyId-callTimestamp, salesmanUid-callTimestamp, shopId-callTimestamp, companyId-reminderDate |

> The old `Shops`, `CallLogs`, `FollowupDismissals` tables and the Google Sheet are not used any more.

## 3. Run / deploy
`npm start` (port 4000). Works on Render as before, or AWS App Runner / Elastic Beanstalk
(then leave the AWS key env vars empty and give the service an IAM role).

## API (all need `Authorization: Bearer <Firebase ID token>` except register)
| Method | Path | Who | |
|---|---|---|---|
| POST | /api/auth/register-company | public | `{companyName, ownerName, email, mobile, password}` |
| GET | /api/auth/me | any | profile + company |
| GET/POST | /api/salesmen | master | add `{name, mobile}` → password `last4@salesman` |
| PATCH | /api/salesmen/:uid | master | `{name?, active?}` |
| POST | /api/salesmen/:uid/reset-password | master | back to `last4@salesman` |
| GET | /api/shops | any | master: all (`?salesmanUid=`), salesman: own only |
| POST | /api/shops | master | `{name, address, phoneNumber, salesmanUid}` |
| POST | /api/shops/upload | master | multipart `file` (.xlsx/.csv): `Shop Name, Address, Phone Number, Salesman Name` |
| PATCH/DELETE | /api/shops/:shopId | master | edit / reassign / delete |
| GET | /api/shops/:shopId/calls | master, assigned salesman | call history |
| POST | /api/call-logs | salesman | `{shopId, callResult, notes?, orderReceived?, orderDetails?, reminderDate?(yyyy-mm-dd)}` |
| PUT | /api/call-logs/:callId | owner | `{notes?, reminderDate?, callResult?, orderReceived?, orderDetails?}` |
| GET | /api/call-logs | any | `?from&to&salesmanUid&status&limit&cursor` |
| GET | /api/followups | any | `{today, missedYesterday}` |
| GET | /api/dashboard | any | `?from&to&salesmanUid` |

Excel template: `GET /templates/shops_upload_template.xlsx`

### Manual call-result workflow
- Open the normal system dialer from Flutter using `url_launcher`; the backend does not need call-log access.
- After returning to the app, the salesperson manually submits `callResult`: `answered`, `no_answer`, `busy`, `unreachable`, or `wrong_number`.
- Optional `notes`, `orderReceived` (boolean), `orderDetails` (JSON object), and `reminderDate` are stored with the call. `orderDetails` is required when `orderReceived` is `true`.
- Dashboard responses include `answeredCalls`, `noAnswerCalls`, `busyCalls`, `unreachableCalls`, `wrongNumberCalls`, and `ordersReceived`. Legacy `connectedCalls`, `notConnectedCalls`, and `callStatus` remain for compatibility.
- Legacy clients that still send `durationSeconds` without `callResult` remain supported temporarily; new Flutter code should always send the manually selected `callResult`.

### Follow-up rules
- **today** = calls whose `reminderDate` is today and still pending.
- **missedYesterday** = yesterday's unanswered, busy, or unreachable calls (latest per shop); wrong-number results are excluded.
- A new call to that shop saved **with a note** closes them automatically. A call without a
  note closes nothing. There is no manual "done".

## Tests
`npm test` — full API flow against an in-memory DynamoDB (dynalite) with fake Firebase.

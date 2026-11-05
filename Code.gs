/**
 * Googleカレンダーの予定を「前々日」に LINE グループへアナウンスする。
 *
 * 設定はスクリプトプロパティに置く（README.md 参照）:
 *   CALENDAR_ID               … 空なら実行アカウントのメインカレンダー
 *   LINE_CHANNEL_ACCESS_TOKEN … Messaging API のチャネルアクセストークン（長期）
 *   LINE_GROUP_ID             … ボットをグループに招待すると doPost が自動で保存する
 */

const DAYS_AHEAD = 2;      // 何日前に知らせるか（2 = 前々日）
const ANNOUNCE_HOUR = 20;  // 毎日この時台（JST）に実行。GAS の仕様で分は毎回ずれる
const TITLE_KEYWORD = '部会';  // タイトルにこの語を含む予定だけ流す。空文字なら全部流す
const TZ = 'Asia/Tokyo';
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// ---- 定期実行の本体 ----

function announce() {
  const target = daysFromToday_(DAYS_AHEAD);
  const events = eventsStartingOn_(target);
  if (events.length === 0) return;  // 予定のない日は送らない（LINE の通数を節約）
  pushLine_(formatMessage_(target, events));
}

// ---- 手動で実行する関数 ----

/** 送らずに、次に流れる文面をログに出す。引数なしなら前々日分 */
function preview(daysAhead) {
  const target = daysFromToday_(typeof daysAhead === 'number' ? daysAhead : DAYS_AHEAD);
  const events = eventsStartingOn_(target);
  Logger.log(events.length ? formatMessage_(target, events) : '（この日の予定はありません）');
}

/** LINE グループにテスト文を送る */
function testSend() {
  pushLine_('🔔 予定アナウンスのテスト送信です');
}

/** 毎日 ANNOUNCE_HOUR 時台に announce を走らせるトリガーを張り直す */
function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'announce')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('announce').timeBased().everyDays(1).atHour(ANNOUNCE_HOUR).inTimezone(TZ).create();
  Logger.log(`毎日 ${ANNOUNCE_HOUR} 時台に実行するトリガーを作成しました`);
}

// ---- LINE の Webhook（グループ ID の取得用）----

/**
 * ボットがグループに招待されたときの join イベントでグループ ID を保存する。
 * GAS ではリクエストヘッダが読めず署名検証ができないため、
 * まだ ID が未設定のときだけ受け付け、設定後は上書きしない。
 */
function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const props = PropertiesService.getScriptProperties();
  (body.events || []).forEach(ev => {
    if (ev.type !== 'join' || ev.source.type !== 'group') return;
    if (props.getProperty('LINE_GROUP_ID')) return;
    props.setProperty('LINE_GROUP_ID', ev.source.groupId);
    callLine_('reply', { replyToken: ev.replyToken, messages: [{ type: 'text', text: `このグループに予定を ${DAYS_AHEAD} 日前にお知らせします📅` }] });
  });
  return ContentService.createTextOutput('OK');
}

// ---- 予定の取得と整形 ----

function daysFromToday_(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

function getCalendar_() {
  const id = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  if (!id) return CalendarApp.getDefaultCalendar();
  const cal = CalendarApp.getCalendarById(id);
  if (!cal) throw new Error(`カレンダーが見つかりません: ${id}`);
  return cal;
}

function startOf_(ev) {
  return ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime();
}

/**
 * その日に「始まる」予定だけを返す。getEventsForDay は日をまたぐ予定も返すので、
 * そのままだと連日の予定が毎日流れてしまう。非公開の予定と、タイトルに TITLE_KEYWORD を含まない予定は流さない。
 */
function eventsStartingOn_(day) {
  const key = Utilities.formatDate(day, TZ, 'yyyyMMdd');
  return getCalendar_().getEventsForDay(day)
    .filter(ev => Utilities.formatDate(startOf_(ev), TZ, 'yyyyMMdd') === key)
    .filter(ev => ev.getTitle().includes(TITLE_KEYWORD))
    .filter(ev => ev.getVisibility() !== CalendarApp.Visibility.PRIVATE)
    .sort((a, b) => (b.isAllDayEvent() - a.isAllDayEvent()) || (startOf_(a) - startOf_(b)));
}

/** 雛形: 時間・場所のあとに、予定の「説明」欄をそのまま載せる（見出しは付けない。空なら何も出さない） */
function formatMessage_(day, events) {
  const date = `${Utilities.formatDate(day, TZ, 'M/d')}(${WEEKDAYS[day.getDay()]})`;
  const blocks = events.map(ev => {
    const when = ev.isAllDayEvent()
      ? '終日'
      : `${Utilities.formatDate(ev.getStartTime(), TZ, 'H:mm')}〜${Utilities.formatDate(ev.getEndTime(), TZ, 'H:mm')}`;
    const lines = [
      `【${ev.getTitle()}】`,
      `時間：${when}`,
      `場所：${ev.getLocation() || '未定'}`,
    ];
    const description = plainText_(ev.getDescription());
    if (description) lines.push(description);
    return lines.join('\n');
  });
  return [`📅 ${date} の予定（${DAYS_AHEAD}日後）`, ...blocks].join('\n\n');
}

/** Web 版カレンダーで書いた説明欄は HTML になっているので、改行を残して素の文字にする */
function plainText_(html) {
  return (html || '')
    .replace(/<br\s*\/?>|<\/(p|div|li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '・')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- 送信 ----

/** 失敗したら例外を投げる。GAS から実行アカウント宛てに失敗通知メールが届く */
function pushLine_(text) {
  const groupId = PropertiesService.getScriptProperties().getProperty('LINE_GROUP_ID');
  if (!groupId) throw new Error('LINE_GROUP_ID が未設定です（ボットをグループに招待してください）');
  callLine_('push', { to: groupId, messages: [{ type: 'text', text: text.slice(0, 5000) }] });  // LINE の上限 5000 字
}

/** kind は 'push' か 'reply'。reply は無料枠の通数に数えられない */
function callLine_(kind, body) {
  const token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN が未設定です');
  const res = UrlFetchApp.fetch(`https://api.line.me/v2/bot/message/${kind}`, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error(`LINE ${kind} ${res.getResponseCode()}: ${res.getContentText()}`);
}

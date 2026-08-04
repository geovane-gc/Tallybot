#!/usr/bin/env node
/**
 * Finance CLI — the tool the Telegram agent drives.
 *
 * Why one CLI with subcommands instead of several scripts: the model driving it
 * is a free tier. A single entry point, named options and always-JSON output cut
 * down the ways it can get a call wrong. Every bit of money, calendar and budget
 * arithmetic lives here — the model decides *what* to record, never *how* to
 * compute it.
 *
 * Output contract, honoured by every subcommand:
 *
 *     success -> {"ok": true,  ...data}       exit 0
 *     failure -> {"ok": false, "error": "…"}  exit 1
 *     no auth -> {"ok": false, "error": "…", "auth_required": true}
 *
 * The `error` text is Portuguese and written to be forwarded to the user as-is;
 * everything else here is English. See the language note in `db.ts`.
 *
 * Usage:
 *     node fin.ts [--db PATH] <subcommand> [options]
 *
 * The database path comes from --db, the TALLY_DB env var, or the default
 * /opt/data/finance/tally.db (inside the container).
 *
 * Two people share this ledger, so every command runs as somebody:
 *
 * - **The identity comes from the environment, not from the model.** Hermes
 *   exports `HERMES_SESSION_USER_ID` into every terminal subprocess it spawns, so
 *   in normal operation the CLI learns who is talking from the gateway and the
 *   agent — an LLM, therefore promptable — does not have to be trusted to say it.
 *   The numeric Telegram id is not in its context either.
 * - `--user <telegram id>` exists for callers outside a gateway session — the
 *   Makefile, the cron scripts, the tests. Inside a session it may only repeat
 *   the id the session already carries; disagreeing is refused.
 * - **None of this is a security boundary, and it must not be described as one.**
 *   The agent runs `terminal` with `backend: local`, as the same uid, on a
 *   writable database file. It can drop the variable (`env -u
 *   HERMES_SESSION_USER_ID …`), pass whatever `--user` it likes, or skip this CLI
 *   entirely and open `tally.db` with `node:sqlite`. Everything here is a
 *   guardrail: it keeps a confused or talked-into-it model from reading the wrong
 *   person's money, and it makes the wrong thing require deliberate effort. The
 *   actual boundary is one level up — the Hermes gateway allowlist, which decides
 *   whose messages reach the agent at all. If the model is hostile and has a
 *   shell, this file cannot save you; harden the gateway.
 * - Authentication is enforced *here*, not by the agent, for the same reason and
 *   with the same limit: every data subcommand refuses to run for someone who has
 *   not entered a code.
 * - The code is either a **per-person invite** (single use, expiring, minted in
 *   the terminal with `auth invite`) or the **shared `TALLY_ACCESS_CODE`**, which
 *   still works. From the chat's point of view they are the same thing: a string
 *   the person types once.
 * - A few subcommands (`auth users`, `auth invite`, `auth invites`,
 *   `auth revoke-invite`, `auth revoke`, `auth logout-all`, `auth unlock`,
 *   `auth adopt-legacy`, and `auth status` without a `--user`) are host/operator
 *   commands. They refuse to run when a gateway session identity is bound, so the
 *   bot cannot enumerate both people, mint itself an invite or log everybody out
 *   because somebody in a chat asked it to. The Makefile and `cron-jobs.sh` bind
 *   no session, so they keep working.
 */

import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import {
  DEFAULT_DB,
  ACCOUNT_TYPES,
  AuthRequiredError,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_INVITE_HOURS,
  FinError,
  LEGACY_TELEGRAM_ID,
  MAX_FAILED_ATTEMPTS,
  MAX_GLOBAL_FAILED_ATTEMPTS,
  MAX_INVITE_HOURS,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
  addDays,
  addMonths,
  adoptLegacy,
  anyInvites,
  applyTags,
  categoryAndChildrenIds,
  clearFailedAttempts,
  connect,
  createInvite,
  currentVersion,
  findUser,
  formatMoney,
  fullCategoryName,
  getSetting,
  globalAuthEpoch,
  globalFailedAttempts,
  init,
  isGloballyLocked,
  isLockedOut,
  isSessionCurrent,
  isValidMonth,
  lastDayOfMonth,
  listInvites,
  listUsers,
  migrate,
  monthOf,
  now,
  parseAmount,
  parseDate,
  periodRange,
  recordFailedAttempt,
  redeemInvite,
  resolveAccount,
  resolveCategory,
  revokeInvite,
  revokeUser,
  seedUser,
  serializeTransaction,
  setGlobalAuthEpoch,
  setSetting,
  sharedCodeConfigured,
  today,
  transaction,
  verifyAccessCode,
  type AccountType,
  type BudgetStatus,
  type Db,
  type Period,
  type TransactionOut,
  type TransactionRow,
  type TransactionStatus,
  type TransactionType,
  type UserRow,
} from "./db.ts";

import { cmdBill } from "./bill.ts";
import { cmdForecast } from "./forecast.ts";
import { buildChart } from "./chart.ts";
import { applyImport, previewImport } from "./statement-import.ts";

type Args = Record<string, string | boolean | undefined>;
type Output = Record<string, unknown>;

const str = (a: Args, k: string): string | undefined => {
  const v = a[k];
  return typeof v === "string" ? v : undefined;
};
const int = (a: Args, k: string): number | undefined => {
  const v = str(a, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new FinError(`--${k} precisa ser um número inteiro.`);
  return n;
};
const flag = (a: Args, k: string): boolean => a[k] === true;

function asTransactionType(v: string | undefined, fallback?: TransactionType) {
  if (v === undefined) return fallback;
  if (!TRANSACTION_TYPES.includes(v as TransactionType)) {
    throw new FinError(`Tipo inválido: ${v}. Use expense, income ou transfer.`);
  }
  return v as TransactionType;
}

/** `--status paid|pending|all`; `all` (the default) means no filter. */
function asStatusFilter(v: string | undefined): TransactionStatus | "all" {
  if (v === undefined || v === "") return "all";
  if (v === "all") return "all";
  if (!TRANSACTION_STATUSES.includes(v as TransactionStatus)) {
    throw new FinError(`Status inválido: ${v}. Use paid, pending ou all.`);
  }
  return v as TransactionStatus;
}

function sum(db: Db, sql: string, params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown>;
  const first = row ? Object.values(row)[0] : 0;
  return Number(first ?? 0);
}

/**
 * Loads one of the caller's transactions.
 *
 * Somebody else's id gets the same "not found" as an id that never existed:
 * confirming that #142 belongs to the other person is itself a leak.
 */
function fetchTransaction(db: Db, userId: number, id: number): TransactionOut {
  const row = db
    .prepare("SELECT * FROM v_transactions WHERE id = ? AND user_id = ?")
    .get(id, userId) as TransactionRow | undefined;
  if (!row) throw new FinError(`Não achei o lançamento #${id}.`);
  return serializeTransaction(db, userId, row);
}

/* -------------------------------------------------------------------------- */
/* Who is calling                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A session variable, treating an empty value as absent.
 *
 * Hermes exports these but leaves `HERMES_SESSION_USER_ID` empty on its
 * anonymised group-observe path, and an empty string must never become a user
 * id — it would collapse everyone who arrives that way into one ledger.
 */
function sessionEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

interface Caller {
  telegramUserId: string;
  chatId?: string;
  chatType?: string;
  /** `session` = the gateway told us; `option` = `--user` on the command line. */
  source: "session" | "option";
}

/**
 * A Telegram user id, and nothing else.
 *
 * Telegram ids are numeric and currently 9-10 digits; the range leaves room in
 * both directions. Validating the shape is what stops `--user legacy` from
 * addressing migration 2's placeholder ledger, and `--user ' OR 1=1` from ever
 * being interesting — the queries are parameterised, but an id that is not an id
 * has no business creating a `users` row.
 */
const TELEGRAM_ID_RE = /^[0-9]{5,20}$/;

function validateUserOption(value: string): string {
  if (value === LEGACY_TELEGRAM_ID) {
    throw new FinError(
      "O histórico antigo ('legacy') não é de ninguém e não pode ser usado como " +
        "identidade. Para adotá-lo, use `auth adopt-legacy` no servidor.",
    );
  }
  if (!TELEGRAM_ID_RE.test(value)) {
    throw new FinError(
      `--user precisa ser um id numérico do Telegram, não ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * Works out who this invocation is acting as.
 *
 * The order matters (and is a guardrail, not a boundary — see the file header):
 *
 * 1. The session's own id wins. If `--user` was passed as well and disagrees,
 *    refuse — that combination only happens when something is trying to act as
 *    somebody else, and picking a side silently is how impersonation ships.
 * 2. With no session identity (host CLI, Makefile, cron scripts, tests),
 *    `--user` is required and honoured.
 * 3. With neither, refuse. Fail closed: no identity, no ledger.
 */
function resolveCaller(a: Args, optional?: false): Caller;
function resolveCaller(a: Args, optional: true): Caller | undefined;
function resolveCaller(a: Args, optional = false): Caller | undefined {
  const raw = (str(a, "user") ?? "").trim() || undefined;
  const passed = raw === undefined ? undefined : validateUserOption(raw);
  const chatId = sessionEnv("HERMES_SESSION_CHAT_ID");
  const chatType = sessionEnv("HERMES_SESSION_CHAT_TYPE");

  let sessionId = sessionEnv("HERMES_SESSION_USER_ID");
  // In a private chat the chat id *is* the person's id, which makes it a sound
  // stand-in when only the chat came through. Never in a group: there the chat
  // id identifies the room, and everyone in it would share one ledger.
  if (!sessionId && chatId && (chatType === "dm" || chatType === "private")) {
    sessionId = chatId;
  }

  if (sessionId) {
    if (passed && passed !== sessionId) {
      throw new FinError(
        "Essa chamada tentou mexer no dinheiro de outra pessoa e foi recusada. " +
          "Cada um só acessa o próprio.",
      );
    }
    return { telegramUserId: sessionId, chatId, chatType, source: "session" };
  }

  if (passed) {
    return { telegramUserId: passed, chatId, chatType, source: "option" };
  }

  // `optional` is only for `auth status`, which falls back to summarising
  // everybody when it cannot tell who is asking.
  if (optional) return undefined;

  throw new FinError(
    "Não consegui identificar quem está falando, então não vou mexer em nada. " +
      "Avise o Geovane.",
  );
}

/**
 * Refuses a host/operator command when a chat turn is what is asking.
 *
 * `auth users`, `auth logout-all`, `auth unlock`, `auth adopt-legacy` and the
 * all-users form of `auth status` are for the terminal on the server. Run from a
 * conversation they would let anyone enumerate both people's Telegram ids, chat
 * ids and login times, or log everybody out on repeat — none of which needed a
 * password before this check existed.
 *
 * The test is "did the gateway bind a session identity". The Makefile and
 * `cron-jobs.sh` bind none, so they are unaffected.
 *
 * **This is a guardrail, not a boundary.** The agent has a shell as the same uid:
 * `env -u HERMES_SESSION_USER_ID node fin.ts auth users` walks straight past it.
 * What it buys is that the bot will not do this because a message asked it to, and
 * that doing it anyway takes a deliberate, visibly odd command.
 */
function requireOperator(a: Args, action: string): void {
  const caller = resolveCaller(a, true);
  if (caller?.source === "session") {
    throw new FinError(
      `\`auth ${action}\` é um comando do operador, e roda só no terminal do ` +
        "servidor. Não posso executar isso a partir de uma conversa.",
    );
  }
}

/** Asked whenever the caller has no valid session. */
const AUTH_PROMPT =
  "Antes de falar de dinheiro eu preciso confirmar quem é você. " +
  "Me manda o código de acesso.";

/**
 * The authenticated user behind this invocation, or a refusal.
 *
 * This is the gate. It runs once, before dispatch, and everything downstream
 * receives the resolved internal `user.id` — no subcommand ever sees a Telegram
 * id or decides for itself whether the caller is allowed in.
 */
function requireUser(db: Db, a: Args): UserRow {
  const caller = resolveCaller(a);
  const user = findUser(db, caller.telegramUserId);

  // One response for "never registered" and for "session revoked", on purpose:
  // the agent handles a single case, and probing ids reveals nothing.
  if (!user || !isSessionCurrent(user, globalAuthEpoch(db))) {
    throw new AuthRequiredError(AUTH_PROMPT);
  }
  return user;
}

/* -------------------------------------------------------------------------- */
/* auth                                                                       */
/* -------------------------------------------------------------------------- */

const LOCKED_OUT =
  `Bloqueei as tentativas depois de ${MAX_FAILED_ATTEMPTS} códigos errados. ` +
  "Peça ao Geovane para liberar o acesso.";

/**
 * Said when the *global* counter trips, not this id's.
 *
 * Same shape as the per-id message on purpose: whoever is guessing does not get
 * to learn which of the two counters they hit, or that a global one exists.
 */
const GLOBALLY_LOCKED_OUT =
  `Bloqueei as tentativas depois de ${MAX_GLOBAL_FAILED_ATTEMPTS} códigos errados. ` +
  "Peça ao Geovane para liberar o acesso.";

/**
 * The one answer to every code that does not open the door.
 *
 * A constant, and used in exactly one place, so that "unknown code", "expired
 * invite", "revoked invite" and "invite already used" cannot drift apart. If they
 * differed, typing a spent code would confirm to an outsider that it once existed.
 */
const WRONG_CODE = "Código incorreto.";

/**
 * A user as the outside world sees them.
 *
 * No attempt count beyond the locked flag, and never anything derived from the
 * access code. `telegram_chat_id` falls back to the user's own id because in a
 * private chat the two are the same value, and a private chat is the only place
 * someone's ledger should ever be delivered.
 */
function publicUser(db: Db, user: UserRow, epoch: number): Output {
  return {
    telegram_user_id: user.telegram_user_id,
    telegram_chat_id: user.telegram_chat_id ?? user.telegram_user_id,
    display_name: user.display_name,
    active: user.active === 1,
    authenticated: user.authenticated_at !== null,
    current: isSessionCurrent(user, epoch),
    locked: isLockedOut(db, user.telegram_user_id),
    authenticated_at: user.authenticated_at,
    auth_epoch: user.auth_epoch,
  };
}

/**
 * The chat to deliver this person's reports to, if we can tell.
 *
 * Only a private conversation qualifies. Recording a group chat here would hand
 * the cron fan-out a room full of people as the destination for one person's
 * spending.
 */
function deliverableChatId(caller: Caller): string | null {
  if (!caller.chatId) return null;
  if (caller.chatType === "dm" || caller.chatType === "private") return caller.chatId;
  return caller.chatId === caller.telegramUserId ? caller.chatId : null;
}

/**
 * Writes the row that says this person is in, and returns their internal id.
 *
 * The upsert is the same for both ways in — an invite and the shared code differ
 * only in what proved the caller may do this. `active = 1` is what brings a
 * revoked person back: they redeem a new invite and find their ledger untouched.
 */
function registerUser(
  db: Db,
  caller: Caller,
  name: string | null,
  ts: string,
  epoch: number,
): number {
  db.prepare(
    "INSERT INTO users (telegram_user_id, telegram_chat_id, display_name," +
      " authenticated_at, auth_epoch, active, created_at)" +
      " VALUES (?, ?, ?, ?, ?, 1, ?)" +
      " ON CONFLICT(telegram_user_id) DO UPDATE SET" +
      "   telegram_chat_id = COALESCE(excluded.telegram_chat_id, telegram_chat_id)," +
      "   display_name     = COALESCE(excluded.display_name, display_name)," +
      "   authenticated_at = excluded.authenticated_at," +
      "   auth_epoch       = excluded.auth_epoch," +
      "   active           = 1",
  ).run(caller.telegramUserId, deliverableChatId(caller), name, ts, epoch, ts);
  return findUser(db, caller.telegramUserId)!.id;
}

/**
 * The shared-code fallback, and what its absence means.
 *
 * An empty `TALLY_ACCESS_CODE` used to be a broken install, full stop. With
 * invites it is also the *finished* install: everybody is registered, the variable
 * is gone, and no standing secret is left for `env` to print. So the two cases are
 * told apart by whether an invite was ever minted — if one was, a code that
 * matched no invite is simply wrong and says exactly that, revealing nothing about
 * how this install lets people in.
 */
function sharedCodeMatches(db: Db, code: string): boolean {
  if (!sharedCodeConfigured() && anyInvites(db)) return false;
  // Throws the "acesso não configurado" FinError when there is no shared code and
  // no invite either, which is the genuinely unconfigured case.
  return verifyAccessCode(code);
}

export function cmdAuth(db: Db, a: Args, positionals: string[]): Output {
  const action = positionals[0] ?? "status";
  const epoch = globalAuthEpoch(db);

  if (action === "login") {
    const caller = resolveCaller(a);
    const code = str(a, "code");
    if (code === undefined || code.trim() === "") {
      throw new FinError("Me manda o código de acesso.");
    }

    const before = findUser(db, caller.telegramUserId);
    // Checked before the code is even compared: a locked id does not get more
    // attempts, right or wrong. Covers the global lock too, which is the one that
    // makes cycling through ids stop working.
    if (isGloballyLocked(db)) throw new FinError(GLOBALLY_LOCKED_OUT);
    if (isLockedOut(db, caller.telegramUserId)) throw new FinError(LOCKED_OUT);

    const ts = now();
    const name = str(a, "name")?.trim() || null;
    const register = () => registerUser(db, caller, name, ts, epoch);

    // Resolution order, and it matters: a personal invite first, the shared code
    // second. An invite is consumed and the user registered in one transaction, so
    // two people redeeming the same code cannot both get in.
    const invite = redeemInvite(db, code, register, ts);
    if (!invite) {
      if (!sharedCodeMatches(db, code)) {
        // Counters live in `app_state`, keyed by the id — no `users` row is created
        // for an id that only ever got the code wrong. That used to be a free way
        // to plant rows in the user list. A wrong invite feeds these same counters:
        // there is one lockout in this codebase, not one per way in.
        recordFailedAttempt(db, caller.telegramUserId);
        // Deliberately the same sentence whatever the state: how many attempts are
        // left would tell an outsider whether that id was already known here, and
        // "expired" versus "wrong" would tell them the code once existed.
        throw new FinError(
          isLockedOut(db, caller.telegramUserId) ? LOCKED_OUT : WRONG_CODE,
        );
      }
      register();
    }

    // "New" means never authenticated, not "no row": the legacy placeholder from
    // migration 2 and an adopted ledger both leave a row waiting with
    // authenticated_at NULL.
    const isNew = !before || before.authenticated_at === null;

    // Getting the code right is proof this is not a guesser, so the counters go
    // back to zero — including the global one, which would otherwise creep up on
    // honest typos until it locked the house.
    clearFailedAttempts(db, caller.telegramUserId);

    const user = findUser(db, caller.telegramUserId)!;
    // Categories, the default account and the settings are per user, so a first
    // login is also when this person's ledger gets built.
    const seeded = seedUser(db, user.id);

    return {
      action: "authenticated",
      new_user: isNew,
      // Which way in was used. The invite's id, never its code — that was printed
      // once, when it was minted, and only its hash was ever stored.
      via: invite ? "invite" : "shared_code",
      invite_id: invite ? invite.id : null,
      seed: seeded,
      user: publicUser(db, findUser(db, caller.telegramUserId)!, epoch),
      message: isNew
        ? "✅ Tudo certo, agora é só me contar seus gastos."
        : "✅ Reconhecido. Pode mandar.",
    };
  }

  if (action === "status") {
    const caller = resolveCaller(a, true);
    // With a session bound, this scopes to the caller and shows their state only.
    // The everybody form below is the operator's, and it is what would otherwise
    // hand a chat turn both people's ids, chat ids and login times.
    if (caller) {
      const user = findUser(db, caller.telegramUserId);
      return {
        auth_epoch: epoch,
        identity_source: caller.source,
        telegram_user_id: caller.telegramUserId,
        registered: user !== undefined && user.authenticated_at !== null,
        current: user ? isSessionCurrent(user, epoch) : false,
        locked: isLockedOut(db, caller.telegramUserId),
        user: user ? publicUser(db, user, epoch) : null,
      };
    }
    requireOperator(a, "status");
    const users = listUsers(db);
    return {
      auth_epoch: epoch,
      // Only the operator sees the global counter: it is the one number that says
      // "somebody is guessing", and it is nobody's business from a chat.
      global_failed_attempts: globalFailedAttempts(db),
      globally_locked: isGloballyLocked(db),
      count: users.length,
      current_count: users.filter((u) => isSessionCurrent(u, epoch)).length,
      users: users.map((u) => publicUser(db, u, epoch)),
    };
  }

  if (action === "users") {
    // Machine-readable on purpose: the cron fan-out reads this to know who to
    // run for and which chat to deliver to. Operator-only: it lists both people.
    requireOperator(a, "users");
    const users = listUsers(db);
    return {
      auth_epoch: epoch,
      count: users.length,
      users: users.map((u) => publicUser(db, u, epoch)),
    };
  }

  if (action === "invite") {
    // Operator-only, and this is the one that must never be reachable from a chat:
    // a bot that can mint an invite is a bot that can invite whoever asks it to.
    requireOperator(a, "invite");
    const label = str(a, "label")?.trim();
    if (!label) {
      throw new FinError(
        'Informe --label "<nome>" para saber depois de quem é esse convite.',
      );
    }
    const hours = int(a, "hours") ?? DEFAULT_INVITE_HOURS;
    if (hours < 1 || hours > MAX_INVITE_HOURS) {
      throw new FinError(`--hours precisa ser entre 1 e ${MAX_INVITE_HOURS}.`);
    }

    const { invite, code } = createInvite(db, label, hours);
    return {
      action: "invite_created",
      // The only time a code is ever in an output. Only its hash was stored, so
      // there is no second chance to read it — not for the bot, not for the
      // operator, not from a backup.
      code,
      invite,
      hours,
      message:
        `🎟️ Convite de ${label}: ${code} — vale ${hours}h e serve uma vez só. ` +
        "Dite pessoalmente; esse código não aparece de novo em lugar nenhum.",
    };
  }

  if (action === "invites") {
    // Operator-only for the same reason as `auth users`: it says who was invited
    // and who came in. Never a code, not even part of one — only the hash was kept
    // and not even that is returned.
    requireOperator(a, "invites");
    const invites = listInvites(db);
    return {
      count: invites.length,
      pending: invites.filter((i) => i.status === "pending").length,
      invites,
    };
  }

  if (action === "revoke-invite") {
    requireOperator(a, "revoke-invite");
    const raw = positionals[1];
    const id = Number(raw);
    if (!raw || !Number.isInteger(id) || id < 1) {
      throw new FinError(
        "Informe o número do convite: `auth revoke-invite <id>`. Rode " +
          "`auth invites` para ver a lista.",
      );
    }
    const { invite, already_revoked } = revokeInvite(db, id);
    return {
      action: "invite_revoked",
      invite,
      already_revoked,
      message: already_revoked
        ? `🎟️ O convite #${id} já estava revogado.`
        : `🎟️ Convite #${id} revogado. Se alguém já tinha esse código, ele não vale mais.`,
    };
  }

  if (action === "revoke") {
    // The scalpel. `logout-all` below is the panic button: it makes *everybody*
    // re-authenticate. This one cuts off a single person and leaves the other
    // working, which is the thing a single shared code could never do.
    requireOperator(a, "revoke");
    const target = str(a, "user")?.trim();
    if (!target) {
      throw new FinError(
        "Informe --user <id do Telegram> para revogar o acesso de uma pessoa.",
      );
    }
    validateUserOption(target);
    const result = revokeUser(db, target, epoch);

    // Said out loud because it is the difference between revoking access and
    // thinking you did: while the shared code is in the environment, this person
    // walks back in by typing it.
    const sharedCodeActive = sharedCodeConfigured();
    return {
      action: "revoked",
      ...result,
      shared_code_active: sharedCodeActive,
      message:
        `🔒 Acesso de ${target} revogado, e só dele. Nenhum lançamento foi apagado ` +
        `(${result.transactions_preserved} continuam no banco). Para voltar, essa ` +
        "pessoa precisa de um convite novo." +
        (sharedCodeActive
          ? " Atenção: TALLY_ACCESS_CODE ainda está configurado, então ela pode " +
            "entrar de novo com o código compartilhado — apague a variável do .env " +
            "para a revogação valer de verdade."
          : ""),
    };
  }

  if (action === "logout-all") {
    requireOperator(a, "logout-all");
    const invalidated = listUsers(db).filter((u) => isSessionCurrent(u, epoch)).length;
    const next = epoch + 1;
    // Only the epoch moves. The failed-attempt counters used to be cleared here,
    // which made this the way to lift a lockout — and since it needed no
    // authentication, the lockout was not a limit at all. Lifting one is
    // `auth unlock` now, deliberately and per id.
    setGlobalAuthEpoch(db, next);
    // No data is touched. Every transaction, account and budget stays exactly
    // where it was; only the sessions die. Same promise as `auth revoke`, which is
    // the per-person version of this.
    return {
      action: "logged_out_all",
      auth_epoch: next,
      sessions_invalidated: invalidated,
      message: `🔒 ${invalidated} sessão(ões) encerrada(s). Todos vão precisar digitar o código de novo.`,
    };
  }

  if (action === "unlock") {
    requireOperator(a, "unlock");
    const target = str(a, "user")?.trim();
    if (!target) throw new FinError("Informe --user <id do Telegram> para desbloquear.");
    const cleared = clearFailedAttempts(db, target);
    return {
      action: "unlocked",
      telegram_user_id: target,
      attempts_cleared: cleared.attempts_cleared,
      global_attempts_cleared: cleared.global_cleared,
      message: `🔓 Tentativas liberadas para ${target}.`,
    };
  }

  if (action === "adopt-legacy") {
    requireOperator(a, "adopt-legacy");
    const target = str(a, "user")?.trim();
    if (!target) {
      throw new FinError("Informe --user <id do Telegram> para adotar o histórico antigo.");
    }
    validateUserOption(target);
    const result = adoptLegacy(db, target);
    const rows = Object.values(result.moved).reduce((acc, n) => acc + n, 0);
    return {
      action: "legacy_adopted",
      ...result,
      rows,
      message:
        `📦 ${rows} registro(s) do histórico antigo agora são de ${target}. ` +
        (result.created_user
          ? "Falta essa pessoa digitar o código de acesso uma vez."
          : "Já pode usar normalmente."),
    };
  }

  throw new FinError(
    `Ação de auth desconhecida: ${action}. Use login, status, users, invite, ` +
      "invites, revoke-invite, revoke, logout-all, unlock ou adopt-legacy.",
  );
}

function splitList(value?: string): string[] {
  if (!value) return [];
  return value
    .replaceAll(";", ",")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** `2026-08-03` -> `03/08`. Year only when it is not the current one. */
function shortDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return year === today().slice(0, 4) ? `${day}/${month}` : `${day}/${month}/${year}`;
}

/** `2026-08-03` -> `03/08/2026`. Exports need the year to sort and filter. */
function fullDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

export function cmdAdd(db: Db, userId: number, a: Args): Output {
  const type = asTransactionType(str(a, "type"), "expense")!;
  const total = parseAmount(str(a, "amount"));
  const date = parseDate(str(a, "date"));
  const description = (str(a, "description") ?? "").trim();
  if (!description) {
    throw new FinError(
      "Descrição é obrigatória — é o que te faz reconhecer o gasto depois.",
    );
  }

  const accountId = resolveAccount(db, userId, str(a, "account"));
  let destAccountId: number | null = null;
  let categoryId: number | null = null;

  if (type === "transfer") {
    const dest = str(a, "dest-account");
    if (!dest) throw new FinError("Transferência precisa de --dest-account.");
    destAccountId = resolveAccount(db, userId, dest, false);
    if (destAccountId === accountId) {
      throw new FinError("A conta de origem e destino são a mesma.");
    }
  } else {
    // `create = true`: better to register a new category than to reject the
    // transaction and have the user lose the record.
    categoryId = resolveCategory(db, userId, str(a, "category"), true);
  }

  const installments = int(a, "installments") ?? 1;
  if (installments < 1 || installments > 120) {
    throw new FinError("Número de parcelas fora do razoável (1 a 120).");
  }

  const ts = now();
  const tags = splitList(str(a, "tags"));
  const group =
    installments > 1 ? randomUUID().replaceAll("-", "").slice(0, 12) : null;

  // Splitting instalments without losing a cent: the remainder goes on the first.
  const base = Math.floor(total / installments);
  const remainder = total - base * installments;

  const created: number[] = [];
  transaction(db, () => {
    const insert = db.prepare(
      "INSERT INTO transactions (" +
        "  user_id, type, amount_cents, description, date, category_id, account_id," +
        "  dest_account_id, note, source, installment_num, installment_total," +
        "  installment_group, created_at, updated_at" +
        ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (let i = 0; i < installments; i++) {
      const info = insert.run(
        userId,
        type,
        base + (i === 0 ? remainder : 0),
        description,
        addMonths(date, i),
        categoryId,
        accountId,
        destAccountId,
        str(a, "note") ?? null,
        str(a, "source") ?? "telegram",
        installments > 1 ? i + 1 : null,
        installments > 1 ? installments : null,
        group,
        ts,
        ts,
      );
      created.push(Number(info.lastInsertRowid));
    }
  });

  if (tags.length) {
    for (const id of created) applyTags(db, userId, id, tags);
  }

  // Only one of the two fields ships in the response: context on a free-tier
  // model is expensive, and returning the same record twice helps nobody.
  const records = created.map((id) => fetchTransaction(db, userId, id));
  const out: Output = {
    id: created[0],
    total_fmt: formatMoney(total),
    installment_plan: installments > 1,
  };
  if (installments > 1) {
    out.installments = records;
    out.installment_amount_fmt = records[records.length - 1].amount_fmt;
  } else {
    out.transaction = records[0];
  }

  // The alert rides along with the confirmation, so the agent can warn about the
  // budget in the same reply instead of making a second call.
  if (type === "expense" && categoryId) {
    out.budget = budgetForCategory(db, userId, categoryId, monthOf(date));
  }

  return out;
}

export function cmdEdit(
  db: Db,
  userId: number,
  a: Args,
  positionals: string[],
): Output {
  const id = Number(positionals[0]);
  if (!Number.isInteger(id)) throw new FinError("Informe o id do lançamento.");
  // The ownership check is this `AND user_id = ?`, and the message is the same
  // one an unknown id gets: editing somebody else's expense by quoting its
  // number is the sharpest way this could go wrong.
  if (!db.prepare("SELECT 1 FROM transactions WHERE id = ? AND user_id = ?").get(id, userId)) {
    throw new FinError(`Não achei o lançamento #${id}.`);
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (str(a, "amount") !== undefined) {
    fields.push("amount_cents = ?");
    values.push(parseAmount(str(a, "amount")));
  }
  if (str(a, "description") !== undefined) {
    fields.push("description = ?");
    values.push(str(a, "description")!.trim());
  }
  if (str(a, "date") !== undefined) {
    fields.push("date = ?");
    values.push(parseDate(str(a, "date")));
  }
  if (str(a, "category") !== undefined) {
    fields.push("category_id = ?");
    values.push(resolveCategory(db, userId, str(a, "category"), true));
  }
  if (str(a, "account") !== undefined) {
    fields.push("account_id = ?");
    values.push(resolveAccount(db, userId, str(a, "account")));
  }
  if (str(a, "type") !== undefined) {
    fields.push("type = ?");
    values.push(asTransactionType(str(a, "type"))!);
  }
  if (str(a, "note") !== undefined) {
    fields.push("note = ?");
    values.push(str(a, "note"));
  }

  const hasTags = str(a, "tags") !== undefined;
  if (!fields.length && !hasTags) {
    throw new FinError("Nada para alterar — informe ao menos um campo.");
  }

  if (fields.length) {
    fields.push("updated_at = ?");
    values.push(now(), id, userId);
    db.prepare(
      `UPDATE transactions SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`,
    ).run(...(values as never[]));
  }

  if (hasTags) applyTags(db, userId, id, splitList(str(a, "tags")));

  const record = fetchTransaction(db, userId, id);
  const out: Output = { transaction: record };
  if (record.type === "expense" && record.category_id) {
    out.budget = budgetForCategory(db, userId, record.category_id, monthOf(record.date));
  }
  return out;
}

export function cmdRm(
  db: Db,
  userId: number,
  a: Args,
  positionals: string[],
): Output {
  const id = Number(positionals[0]);
  if (!Number.isInteger(id)) throw new FinError("Informe o id do lançamento.");
  const target = db
    .prepare("SELECT * FROM transactions WHERE id = ? AND user_id = ?")
    .get(id, userId) as { installment_group: string | null } | undefined;
  if (!target) throw new FinError(`Não achei o lançamento #${id}.`);

  let ids = [id];
  if (flag(a, "group") && target.installment_group) {
    ids = (
      db
        .prepare(
          "SELECT id FROM transactions WHERE installment_group = ? AND user_id = ?",
        )
        .all(target.installment_group, userId) as { id: number }[]
    ).map((r) => r.id);
  }

  const removed = ids.map((i) => fetchTransaction(db, userId, i));
  transaction(db, () => {
    const del = db.prepare("DELETE FROM transactions WHERE id = ? AND user_id = ?");
    for (const i of ids) del.run(i, userId);
  });

  return { removed, count: ids.length };
}

interface Filters {
  where: string;
  params: unknown[];
  context: Output;
}

function buildFilters(db: Db, userId: number, a: Args): Filters {
  // The user clause leads, so every query built on top of these filters is
  // scoped whether or not the caller passed any filter at all.
  const clauses = ["user_id = ?"];
  const params: unknown[] = [userId];
  const context: Output = {};

  const period = str(a, "period");
  if (period) {
    const p = periodRange(period);
    clauses.push("date BETWEEN ? AND ?");
    params.push(p.start, p.end);
    context.period = p;
  }

  const category = str(a, "category");
  if (category) {
    const categoryId = resolveCategory(db, userId, category)!;
    const ids = categoryAndChildrenIds(db, userId, categoryId);
    clauses.push(`category_id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
    context.category = fullCategoryName(db, userId, categoryId);
  }

  const account = str(a, "account");
  if (account) {
    const accountId = resolveAccount(db, userId, account, false);
    clauses.push("(account_id = ? OR dest_account_id = ?)");
    params.push(accountId, accountId);
    context.account = account;
  }

  const type = str(a, "type");
  if (type) {
    clauses.push("type = ?");
    params.push(asTransactionType(type)!);
    context.type = type;
  }

  // Defaults to everything: somebody asking for "meus lançamentos" means the
  // bills they owe as well as the ones they paid.
  const status = asStatusFilter(str(a, "status"));
  if (status !== "all") {
    clauses.push("status = ?");
    params.push(status);
  }
  context.status = status;

  const tag = str(a, "tag");
  if (tag) {
    clauses.push(
      "id IN (SELECT tt.transaction_id FROM transaction_tags tt " +
        "JOIN tags t ON t.id = tt.tag_id WHERE t.name = ? AND t.user_id = ?)",
    );
    params.push(tag.replace(/^#/, ""), userId);
    context.tag = tag;
  }

  const text = str(a, "text");
  if (text) {
    clauses.push("description LIKE ? COLLATE NOCASE");
    params.push(`%${text}%`);
    context.text = text;
  }

  return { where: clauses.join(" AND "), params, context };
}

function totalsByType(db: Db, where: string, params: unknown[]): Output {
  const rows = db
    .prepare(
      `SELECT type, SUM(amount_cents) AS s, COUNT(*) AS n FROM v_transactions WHERE ${where} GROUP BY type`,
    )
    .all(...(params as never[])) as { type: TransactionType; s: number; n: number }[];

  const byType = new Map(rows.map((r) => [r.type, r]));
  const out: Output = {};
  for (const type of TRANSACTION_TYPES) {
    const info = byType.get(type);
    const value = Number(info?.s ?? 0);
    out[type] = {
      cents: value,
      fmt: formatMoney(value),
      count: Number(info?.n ?? 0),
    };
  }
  return out;
}

export function cmdLs(db: Db, userId: number, a: Args): Output {
  const { where, params, context } = buildFilters(db, userId, a);
  const order = str(a, "order") === "asc" ? "date ASC, id ASC" : "date DESC, id DESC";
  const limit = Math.max(1, Math.min(int(a, "limit") ?? 30, 500));

  const rows = db
    .prepare(`SELECT * FROM v_transactions WHERE ${where} ORDER BY ${order} LIMIT ?`)
    .all(...([...params, limit] as never[])) as TransactionRow[];

  const items = rows.map((r) => serializeTransaction(db, userId, r));
  const totals = totalsByType(db, where, params);
  const totalCount = TRANSACTION_TYPES.reduce(
    (acc, t) => acc + Number((totals[t] as { count: number }).count),
    0,
  );
  // Over the same filter, so it lines up with `totals` above: how much of what
  // was matched is still owed rather than gone.
  const pending = sum(
    db,
    `SELECT SUM(amount_cents) FROM v_transactions WHERE ${where} AND status = 'pending'`,
    params,
  );

  return {
    filter: context,
    shown_count: items.length,
    total_count: totalCount,
    totals,
    pending_cents: pending,
    pending_fmt: formatMoney(pending),
    transactions: items,
  };
}

export function cmdSearch(
  db: Db,
  userId: number,
  a: Args,
  positionals: string[],
): Output {
  const term = (positionals[0] ?? "").trim();
  if (!term) throw new FinError("Informe o que buscar.");
  const limit = Math.max(1, Math.min(int(a, "limit") ?? 20, 200));
  const like = `%${term}%`;

  const rows = db
    .prepare(
      "SELECT * FROM v_transactions WHERE user_id = ? AND (" +
        "description LIKE ? COLLATE NOCASE " +
        "OR IFNULL(note,'') LIKE ? COLLATE NOCASE) " +
        "ORDER BY date DESC, id DESC LIMIT ?",
    )
    .all(userId, like, like, limit) as TransactionRow[];

  const items = rows.map((r) => serializeTransaction(db, userId, r));
  // Paid and pending kept apart here too, so the total means "money that left"
  // wherever it appears in this file.
  const expenses = items.filter((i) => i.type === "expense");
  const spent = expenses
    .filter((i) => i.status === "paid")
    .reduce((acc, i) => acc + i.amount_cents, 0);
  const pending = expenses
    .filter((i) => i.status === "pending")
    .reduce((acc, i) => acc + i.amount_cents, 0);

  return {
    term,
    count: items.length,
    total_expenses_fmt: formatMoney(spent),
    pending_cents: pending,
    pending_fmt: formatMoney(pending),
    transactions: items,
  };
}

/**
 * Balance per account plus net worth.
 *
 * A credit card shows a negative balance while its bill is open — reading
 * "-R$ 800,00" as "you owe R$ 800,00" is the intended behaviour.
 *
 * **Only `status = 'paid'` counts here.** The balance is real cash: a fixed cost
 * that fell due and has not been paid has not left the account, and showing it as
 * gone would have the user believing they are poorer than they are — and then
 * paying the bill would move nothing. What is committed but still in there comes
 * back separately, as `pending_cents`, so it can be said out loud instead of
 * silently folded in.
 */
export function cmdBalance(db: Db, userId: number): Output {
  const accounts = db
    .prepare("SELECT * FROM accounts WHERE user_id = ? AND active = 1 ORDER BY type, name")
    .all(userId) as {
    id: number;
    name: string;
    type: AccountType;
    institution: string | null;
    due_day: number | null;
    limit_cents: number | null;
    opening_balance_cents: number;
  }[];

  const currentMonth = monthOf(today());
  const result: Output[] = [];
  let total = 0;
  let totalExcludingCards = 0;
  let totalPending = 0;

  for (const acc of accounts) {
    // The account already belongs to this user, so `user_id` here is redundant —
    // and kept anyway, so that every single query against `transactions` in this
    // file carries the same filter and an audit needs no exceptions.
    const income = sum(
      db,
      "SELECT SUM(amount_cents) FROM transactions " +
        "WHERE user_id = ? AND account_id = ? AND type = 'income' AND status = 'paid'",
      [userId, acc.id],
    );
    const expenses = sum(
      db,
      "SELECT SUM(amount_cents) FROM transactions " +
        "WHERE user_id = ? AND account_id = ? AND type = 'expense' AND status = 'paid'",
      [userId, acc.id],
    );
    const out = sum(
      db,
      "SELECT SUM(amount_cents) FROM transactions " +
        "WHERE user_id = ? AND account_id = ? AND type = 'transfer' AND status = 'paid'",
      [userId, acc.id],
    );
    const incoming = sum(
      db,
      "SELECT SUM(amount_cents) FROM transactions " +
        "WHERE user_id = ? AND dest_account_id = ? AND type = 'transfer' AND status = 'paid'",
      [userId, acc.id],
    );
    // Money already committed on this account and not yet out. Only expenses can
    // be pending (see `recurring apply`), so this is a debt, not a net figure.
    const pending = sum(
      db,
      "SELECT SUM(amount_cents) FROM transactions " +
        "WHERE user_id = ? AND account_id = ? AND status = 'pending'",
      [userId, acc.id],
    );

    const balance = acc.opening_balance_cents + income + incoming - expenses - out;

    const item: Output = {
      id: acc.id,
      name: acc.name,
      type: acc.type,
      institution: acc.institution,
      balance_cents: balance,
      balance_fmt: formatMoney(balance),
      pending_cents: pending,
      pending_fmt: formatMoney(pending),
    };

    if (acc.type === "card") {
      const bill = sum(
        db,
        "SELECT SUM(amount_cents) FROM transactions WHERE user_id = ? " +
          "AND account_id = ? AND type = 'expense' AND status = 'paid' " +
          "AND substr(date,1,7) = ?",
        [userId, acc.id, currentMonth],
      );
      item.month_bill_cents = bill;
      item.month_bill_fmt = formatMoney(bill);
      item.due_day = acc.due_day;
      if (acc.limit_cents) {
        item.limit_fmt = formatMoney(acc.limit_cents);
        item.limit_used_pct = Math.round((bill * 1000) / acc.limit_cents) / 10;
      }
    } else {
      totalExcludingCards += balance;
    }

    total += balance;
    totalPending += pending;
    result.push(item);
  }

  return {
    accounts: result,
    total_cents: total,
    total_fmt: formatMoney(total),
    total_excluding_cards_fmt: formatMoney(totalExcludingCards),
    total_pending_cents: totalPending,
    total_pending_fmt: formatMoney(totalPending),
  };
}

interface PendingBill extends Output {
  id: number;
  description: string;
  date: string;
  amount_cents: number;
  amount_fmt: string;
  category: string;
  account: string;
  days_overdue: number;
}

interface Aggregate extends Output {
  expenses_cents: number;
  pending_cents: number;
  pending_count: number;
  pending: PendingBill[];
  income_cents: number;
  by_category: {
    category: string;
    emoji: string | null;
    total_cents: number;
    total_fmt: string;
    count: number;
    pct: number;
  }[];
  top_expenses: TransactionOut[];
  count: number;
}

/** How many days late a due date is, relative to today. Never negative. */
function daysOverdue(due: string, reference = today()): number {
  const days = Math.round(
    (Date.parse(`${reference}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000,
  );
  return Math.max(0, days);
}

/** The bills in this window that are due and not settled, oldest first. */
function pendingBills(
  db: Db,
  userId: number,
  start: string,
  end: string,
): PendingBill[] {
  const rows = db
    .prepare(
      "SELECT * FROM v_transactions WHERE user_id = ? AND status = 'pending' " +
        "AND date BETWEEN ? AND ? ORDER BY date ASC, id ASC",
    )
    .all(userId, start, end) as TransactionRow[];
  return rows.map((r) => ({
    id: r.id,
    description: r.description,
    date: r.date,
    amount_cents: r.amount_cents,
    amount_fmt: formatMoney(r.amount_cents),
    category: r.parent_category ? `${r.parent_category} > ${r.category}` : r.category,
    account: r.account,
    days_overdue: daysOverdue(r.date),
  }));
}

/**
 * Raw numbers for a date range.
 *
 * Transfers stay out of the totals: moving money between your own accounts is
 * neither spending nor income.
 *
 * The headline figures — `expenses_cents`, the category and account breakdowns,
 * the daily average, the largest expenses — are **paid** only, so "gastei" keeps
 * meaning money that actually left. What is due and unpaid comes back as its own
 * block (`pending_cents`, `pending[]`) rather than being mixed in, because those
 * two numbers answer different questions and adding them would answer neither.
 * `count` covers both, so a period holding nothing but unpaid bills is not
 * reported as empty.
 */
function aggregate(db: Db, userId: number, start: string, end: string): Aggregate {
  const expenses = sum(
    db,
    "SELECT SUM(amount_cents) FROM transactions " +
      "WHERE user_id = ? AND type='expense' AND status='paid' AND date BETWEEN ? AND ?",
    [userId, start, end],
  );
  const income = sum(
    db,
    "SELECT SUM(amount_cents) FROM transactions " +
      "WHERE user_id = ? AND type='income' AND status='paid' AND date BETWEEN ? AND ?",
    [userId, start, end],
  );
  const count = sum(
    db,
    "SELECT COUNT(*) FROM transactions WHERE user_id = ? AND date BETWEEN ? AND ?",
    [userId, start, end],
  );
  const pending = pendingBills(db, userId, start, end);
  const pendingCents = pending.reduce((acc, p) => acc + p.amount_cents, 0);

  // Rolls up to the root category: a report with 40 subcategories is unreadable
  // on Telegram, and the root is the real unit of decision.
  const categoryRows = db
    .prepare(
      "SELECT COALESCE(cp.name, c.name, 'Sem categoria') AS category," +
        "       COALESCE(cp.emoji, c.emoji)              AS emoji," +
        "       SUM(t.amount_cents)                      AS total," +
        "       COUNT(*)                                 AS n " +
        "FROM transactions t " +
        "LEFT JOIN categories c  ON c.id = t.category_id " +
        "LEFT JOIN categories cp ON cp.id = c.parent_id " +
        "WHERE t.user_id = ? AND t.type = 'expense' AND t.status = 'paid' " +
        "AND t.date BETWEEN ? AND ? " +
        "GROUP BY category ORDER BY total DESC",
    )
    .all(userId, start, end) as {
    category: string;
    emoji: string | null;
    total: number;
    n: number;
  }[];

  const accountRows = db
    .prepare(
      "SELECT COALESCE(a.name,'Sem conta') AS account, SUM(t.amount_cents) AS total, COUNT(*) AS n " +
        "FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id " +
        "WHERE t.user_id = ? AND t.type='expense' AND t.status='paid' " +
        "AND t.date BETWEEN ? AND ? " +
        "GROUP BY account ORDER BY total DESC",
    )
    .all(userId, start, end) as { account: string; total: number; n: number }[];

  const top = (
    db
      .prepare(
        "SELECT * FROM v_transactions " +
          "WHERE user_id = ? AND type='expense' AND status='paid' " +
          "AND date BETWEEN ? AND ? " +
          "ORDER BY amount_cents DESC LIMIT 10",
      )
      .all(userId, start, end) as TransactionRow[]
  ).map((r) => serializeTransaction(db, userId, r));

  const days =
    Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000,
    ) + 1;

  return {
    expenses_cents: expenses,
    expenses_fmt: formatMoney(expenses),
    pending_cents: pendingCents,
    pending_fmt: formatMoney(pendingCents),
    pending_count: pending.length,
    pending,
    income_cents: income,
    income_fmt: formatMoney(income),
    net_cents: income - expenses,
    net_fmt: formatMoney(income - expenses),
    daily_average_fmt: days ? formatMoney(Math.trunc(expenses / days)) : formatMoney(0),
    days,
    count,
    by_category: categoryRows.map((r) => ({
      category: r.category,
      emoji: r.emoji,
      total_cents: r.total,
      total_fmt: formatMoney(r.total),
      count: r.n,
      pct: expenses ? Math.round((r.total * 1000) / expenses) / 10 : 0,
    })),
    by_account: accountRows.map((r) => ({
      account: r.account,
      total_cents: r.total,
      total_fmt: formatMoney(r.total),
      count: r.n,
    })),
    top_expenses: top,
  };
}

/**
 * The window immediately before, of the same length.
 *
 * For a full calendar month it returns the previous calendar month — not "31
 * days ago" — which is the comparison that makes sense in a monthly report.
 */
function previousWindow(start: string, end: string): { start: string; end: string } {
  const [, , startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);

  if (startDay === 1 && endDay === lastDayOfMonth(endYear, endMonth)) {
    const previousEnd = addDays(start, -1);
    const [y, m] = previousEnd.split("-").map(Number);
    return { start: `${y}-${String(m).padStart(2, "0")}-01`, end: previousEnd };
  }

  const days =
    Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000,
    ) + 1;
  const newEnd = addDays(start, -1);
  return { start: addDays(newEnd, -(days - 1)), end: newEnd };
}

export function cmdSummary(db: Db, userId: number, a: Args): Output {
  const p = periodRange(str(a, "period") ?? "month");
  const data: Output = { ...aggregate(db, userId, p.start, p.end), period: p };

  if (!flag(a, "no-compare")) {
    const prev = previousWindow(p.start, p.end);
    const previous = aggregate(db, userId, prev.start, prev.end);
    const current = data.expenses_cents as number;
    data.comparison = {
      previous_period: prev,
      previous_expenses_fmt: formatMoney(previous.expenses_cents),
      change_pct: previous.expenses_cents
        ? Math.round(((current - previous.expenses_cents) * 1000) / previous.expenses_cents) /
          10
        : null,
      difference_fmt: formatMoney(current - previous.expenses_cents),
    };
  }

  return data;
}

/**
 * A report in Portuguese, ready to send on Telegram.
 *
 * No markdown tables — Telegram does not render them. No space alignment — the
 * font is proportional and columns would come out crooked. One fact per line,
 * with an emoji as the visual anchor.
 */
export function cmdReport(db: Db, userId: number, a: Args): Output {
  const p = periodRange(str(a, "period") ?? "month");
  const r = aggregate(db, userId, p.start, p.end);
  const prev = previousWindow(p.start, p.end);
  const previous = aggregate(db, userId, prev.start, prev.end);
  const top = int(a, "top") ?? 8;

  const lines: string[] = [];
  // An em dash instead of "Resumo de %s": the labels do not all agree with the
  // same preposition in Portuguese ("de ontem" works, "de este mês" does not).
  lines.push(`📊 *${str(a, "title") ?? `Resumo — ${p.label}`}*`);
  lines.push(`_${shortDate(p.start)} a ${shortDate(p.end)}_`);
  lines.push("");
  lines.push(`💸 Gastos: *${r.expenses_fmt}*`);
  lines.push(`💰 Entradas: *${r.income_fmt}*`);

  const net = r.income_cents - r.expenses_cents;
  lines.push(`${net >= 0 ? "🟢" : "🔴"} Resultado: *${formatMoney(net)}*`);

  if (previous.expenses_cents) {
    const delta = r.expenses_cents - previous.expenses_cents;
    const pct = (Math.abs(delta) * 100) / previous.expenses_cents;
    if (pct < 1) {
      lines.push("➡️ Praticamente igual ao período anterior.");
    } else if (delta > 0) {
      lines.push(
        `📈 ${Math.round(pct)}% acima do período anterior (${formatMoney(delta)})`,
      );
    } else {
      lines.push(
        `📉 ${Math.round(pct)}% abaixo do período anterior (${formatMoney(-delta)})`,
      );
    }
  }

  if (r.by_category.length) {
    lines.push("");
    lines.push("*Onde o dinheiro foi:*");
    for (const c of r.by_category.slice(0, top)) {
      lines.push(`${c.emoji ?? "•"} ${c.category} — ${c.total_fmt} (${Math.round(c.pct)}%)`);
    }
    const rest = r.by_category.length - top;
    if (rest > 0) lines.push(`_... e ${rest} categoria(s) menor(es)_`);
  }

  if (r.top_expenses.length) {
    lines.push("");
    lines.push("*Maiores gastos:*");
    for (const g of r.top_expenses.slice(0, 5)) {
      lines.push(`• ${g.description} — ${g.amount_fmt} (${shortDate(g.date)})`);
    }
  }

  // What is due and not settled, as its own block: it is not spending yet, and
  // burying it inside the totals is how a bill gets forgotten.
  if (r.pending.length) {
    lines.push("");
    lines.push(`*A pagar:* ${r.pending_fmt}`);
    for (const b of r.pending) {
      const late =
        b.days_overdue > 0
          ? ` — ${b.days_overdue} dia${b.days_overdue > 1 ? "s" : ""} em atraso`
          : "";
      lines.push(`⏳ ${b.description} — ${b.amount_fmt} · vence ${shortDate(b.date)}${late}`);
    }
  }

  const budgets = budgetStatuses(db, userId, monthOf(p.end));
  const over = budgets.filter((b) => b.pct >= 100);
  const nearing = budgets.filter((b) => b.pct < 100 && b.pct >= b.alert_pct);
  if (over.length || nearing.length) {
    lines.push("");
    lines.push("*Orçamentos:*");
    // The figure quoted is the committed one — paid plus what is due — because
    // that is what the limit is about. The tail says how much of it is still to
    // pay, so the number can be reconciled against the balance.
    const stillDue = (b: (typeof budgets)[number]) =>
      b.pending_cents ? ` (${b.pending_fmt} ainda a pagar)` : "";
    for (const b of over) {
      lines.push(
        `🔴 ${b.category} estourou: ${b.committed_fmt} de ${b.limit_fmt} ` +
          `(${Math.round(b.pct)}%)${stillDue(b)}`,
      );
    }
    for (const b of nearing) {
      lines.push(
        `🟡 ${b.category} em ${Math.round(b.pct)}%: ${b.committed_fmt} de ` +
          `${b.limit_fmt}${stillDue(b)}`,
      );
    }
  }

  const text =
    r.count === 0
      ? [...lines.slice(0, 3), "Nenhum lançamento registrado neste período."].join("\n")
      : lines.join("\n");

  return {
    period: p,
    text,
    data: flag(a, "with-data") ? r : null,
  };
}

interface BudgetState {
  category_id: number | null;
  category: string;
  month: string;
  month_specific: boolean;
  limit_cents: number;
  limit_fmt: string;
  /** Paid only — money that has actually left. */
  spent_cents: number;
  spent_fmt: string;
  /** Due and not paid yet. Part of `committed_cents`, never of `spent_cents`. */
  pending_cents: number;
  pending_fmt: string;
  /** Paid + pending. This is what `pct` and `status` are computed from. */
  committed_cents: number;
  committed_fmt: string;
  remaining_cents: number;
  remaining_fmt: string;
  pct: number;
  alert_pct: number;
  status: BudgetStatus;
}

/**
 * Where each budget stands this month.
 *
 * A month-specific budget takes precedence over the recurring one (month NULL)
 * for the same category.
 *
 * **Budgets count paid and pending together.** The point of a limit is to stop
 * the money being spent twice, and rent that is due is already gone in every
 * sense that matters for that decision — even though it is still in the account.
 * So `pct` and `status` follow `committed_cents`, and `spent_cents` stays paid-only
 * so a report can say "R$ 450 de R$ 500, R$ 120 disso ainda a pagar" instead of
 * one number that means neither.
 */
function budgetStatuses(db: Db, userId: number, month: string): BudgetState[] {
  const rows = db
    .prepare(
      "SELECT * FROM budgets WHERE user_id = ? AND (month IS NULL OR month = ?) " +
        "ORDER BY (month IS NULL)",
    )
    .all(userId, month) as {
    category_id: number | null;
    month: string | null;
    limit_cents: number;
    alert_pct: number;
  }[];

  const seen = new Set<number | null>();
  const states: BudgetState[] = [];

  for (const b of rows) {
    if (seen.has(b.category_id)) continue;
    seen.add(b.category_id);

    let spent: number;
    let pending: number;
    let name: string;
    if (b.category_id) {
      const ids = categoryAndChildrenIds(db, userId, b.category_id);
      const placeholders = ids.map(() => "?").join(",");
      const scoped = (status: string) =>
        sum(
          db,
          "SELECT SUM(amount_cents) FROM transactions WHERE user_id = ? AND type='expense' " +
            `AND status = ? AND substr(date,1,7) = ? AND category_id IN (${placeholders})`,
          [userId, status, month, ...ids],
        );
      spent = scoped("paid");
      pending = scoped("pending");
      name = fullCategoryName(db, userId, b.category_id);
    } else {
      const global = (status: string) =>
        sum(
          db,
          "SELECT SUM(amount_cents) FROM transactions " +
            "WHERE user_id = ? AND type='expense' AND status = ? AND substr(date,1,7) = ?",
          [userId, status, month],
        );
      spent = global("paid");
      pending = global("pending");
      name = "Total do mês";
    }

    const limit = b.limit_cents;
    const committed = spent + pending;
    const pct = limit ? Math.round((committed * 1000) / limit) / 10 : 0;

    states.push({
      category_id: b.category_id,
      category: name,
      month,
      month_specific: b.month !== null,
      limit_cents: limit,
      limit_fmt: formatMoney(limit),
      spent_cents: spent,
      spent_fmt: formatMoney(spent),
      pending_cents: pending,
      pending_fmt: formatMoney(pending),
      committed_cents: committed,
      committed_fmt: formatMoney(committed),
      remaining_cents: limit - committed,
      remaining_fmt: formatMoney(limit - committed),
      pct,
      alert_pct: b.alert_pct,
      status: pct >= 100 ? "over" : pct >= b.alert_pct ? "warning" : "ok",
    });
  }

  states.sort((a, b) => b.pct - a.pct);
  return states;
}

/**
 * The budget covering this category (itself, its parent, or the global cap) —
 * what the agent needs right after recording the expense.
 */
function budgetForCategory(
  db: Db,
  userId: number,
  categoryId: number,
  month: string,
): BudgetState | null {
  const row = db
    .prepare("SELECT parent_id FROM categories WHERE id = ? AND user_id = ?")
    .get(categoryId, userId) as { parent_id: number | null } | undefined;

  const candidates = [categoryId];
  if (row?.parent_id) candidates.push(row.parent_id);

  const all = budgetStatuses(db, userId, month);
  for (const candidate of candidates) {
    const found = all.find((b) => b.category_id === candidate);
    if (found) return found;
  }
  return all.find((b) => b.category_id === null) ?? null;
}

export function cmdBudget(
  db: Db,
  userId: number,
  a: Args,
  positionals: string[],
): Output {
  const action = positionals[0] ?? "status";
  const monthArg = str(a, "month");

  if (action === "set") {
    const limit = parseAmount(str(a, "limit"));
    const categoryId = str(a, "category")
      ? resolveCategory(db, userId, str(a, "category"))
      : null;
    if (monthArg && !isValidMonth(monthArg)) {
      throw new FinError(`Mês inválido: ${monthArg}. Use YYYY-MM.`);
    }
    const alertPct = int(a, "alert") ?? 80;

    // Delete-then-insert rather than ON CONFLICT: in SQLite a UNIQUE with a NULL
    // column never conflicts (NULLs are distinct), so ON CONFLICT would never
    // fire for the global cap (category_id NULL) or a monthless budget, and each
    // `set` would create a duplicate. `IS` compares NULL correctly.
    transaction(db, () => {
      db.prepare(
        "DELETE FROM budgets WHERE user_id = ? AND category_id IS ? AND month IS ?",
      ).run(userId, categoryId, monthArg ?? null);
      db.prepare(
        "INSERT INTO budgets (user_id, category_id, month, limit_cents, alert_pct, created_at) " +
          "VALUES (?,?,?,?,?,?)",
      ).run(userId, categoryId, monthArg ?? null, limit, alertPct, now());
    });

    return {
      action: "set",
      target: categoryId ? fullCategoryName(db, userId, categoryId) : "Total do mês",
      limit_fmt: formatMoney(limit),
      alert_pct: alertPct,
      status: budgetStatuses(db, userId, monthArg ?? monthOf(today())),
    };
  }

  if (action === "rm") {
    const categoryId = str(a, "category")
      ? resolveCategory(db, userId, str(a, "category"))
      : null;
    const info = db
      .prepare("DELETE FROM budgets WHERE user_id = ? AND category_id IS ? AND month IS ?")
      .run(userId, categoryId, monthArg ?? null);
    if (!Number(info.changes)) {
      throw new FinError("Não havia orçamento definido para esse alvo.");
    }
    return { action: "removed", count: Number(info.changes) };
  }

  const month = monthArg ?? monthOf(today());
  const states = budgetStatuses(db, userId, month);
  return {
    month,
    count: states.length,
    budgets: states,
    over_budget: states.filter((b) => b.pct >= 100),
  };
}

/**
 * Checks limits and returns only what deserves a notification.
 *
 * Built for cron: with nothing new, `silent` comes back true and the agent
 * replies `[SILENT]`, which Hermes treats as "deliver nothing". Without it the
 * bot would say "all good" several times a day.
 */
export function cmdAlerts(db: Db, userId: number, a: Args): Output {
  const month = str(a, "month") ?? monthOf(today());
  const states = budgetStatuses(db, userId, month);
  const mark = flag(a, "mark");
  const repeat = flag(a, "repeat");

  const alerts: Output[] = [];
  for (const b of states) {
    if (b.status === "ok") continue;
    const level = b.status;
    const key = `budget:${b.category_id ?? "global"}`;

    if (!repeat) {
      const already = db
        .prepare(
          "SELECT 1 FROM sent_alerts WHERE user_id=? AND key=? AND month=? AND level=?",
        )
        .get(userId, key, month, level);
      if (already) continue;
    }

    const pct = Math.round(b.pct);
    // Alerts talk about the committed figure, because the warning exists to stop
    // money being promised twice. When part of it is a bill still to pay, the
    // message says so — otherwise the number would not match the balance and the
    // user would think the alert is wrong.
    const stillDue = b.pending_cents ? ` ${b.pending_fmt} disso ainda a pagar.` : "";
    alerts.push({
      key,
      level,
      category: b.category,
      limit_fmt: b.limit_fmt,
      spent_fmt: b.spent_fmt,
      pending_fmt: b.pending_fmt,
      committed_fmt: b.committed_fmt,
      remaining_fmt: b.remaining_fmt,
      pct: b.pct,
      message:
        level === "over"
          ? `🔴 ${b.category} estourou o limite do mês: ${b.committed_fmt} de ${b.limit_fmt} (${pct}%).${stillDue}`
          : `🟡 ${b.category} já está em ${pct}% do limite: ${b.committed_fmt} de ${b.limit_fmt}. Restam ${b.remaining_fmt}.${stillDue}`,
    });
  }

  if (mark && alerts.length) {
    const ts = now();
    transaction(db, () => {
      const insert = db.prepare(
        "INSERT OR REPLACE INTO sent_alerts (user_id, key, month, level, sent_at) " +
          "VALUES (?,?,?,?,?)",
      );
      for (const al of alerts) {
        insert.run(userId, al.key as string, month, al.level as string, ts);
      }
    });
  }

  return {
    month,
    silent: alerts.length === 0,
    count: alerts.length,
    alerts,
  };
}

export function cmdAccount(
  db: Db,
  userId: number,
  a: Args,
  positionals: string[],
): Output {
  const action = positionals[0] ?? "list";
  const name = str(a, "name");

  if (action === "add") {
    if (!name) throw new FinError("Informe --name.");
    const type = (str(a, "type") ?? "checking") as AccountType;
    if (!ACCOUNT_TYPES.includes(type)) {
      throw new FinError(`Tipo de conta inválido. Use um de: ${ACCOUNT_TYPES.join(", ")}.`);
    }
    try {
      // UNIQUE is (user_id, name) now, so the other person having a "Nubank"
      // does not stop this one from creating theirs.
      const info = db
        .prepare(
          "INSERT INTO accounts (user_id, name, type, institution, closing_day, due_day," +
            " limit_cents, opening_balance_cents, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          userId,
          name.trim(),
          type,
          str(a, "institution") ?? null,
          int(a, "closing") ?? null,
          int(a, "due") ?? null,
          str(a, "limit") ? parseAmount(str(a, "limit")) : null,
          str(a, "opening-balance") ? parseAmount(str(a, "opening-balance")) : 0,
          now(),
        );
      return { action: "created", id: Number(info.lastInsertRowid), name: name.trim() };
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) {
        throw new FinError(`Já existe uma conta chamada ${JSON.stringify(name)}.`);
      }
      throw e;
    }
  }

  if (action === "rm") {
    // `--name` is required, like it is for `add`. Without it `resolveAccount`
    // returns null, the old `!` waved that through, and `UPDATE ... WHERE id =
    // NULL` matched nothing while the command still answered `ok: true`.
    if (!name) throw new FinError("Informe --name.");
    const accountId = resolveAccount(db, userId, name, false);
    if (accountId === null) throw new FinError("Informe --name.");
    const uses = sum(
      db,
      "SELECT COUNT(*) FROM transactions " +
        "WHERE user_id = ? AND (account_id = ? OR dest_account_id = ?)",
      [userId, accountId, accountId],
    );
    // Deactivate instead of deleting: removing the account would take the
    // history attached to it.
    db.prepare("UPDATE accounts SET active = 0 WHERE id = ? AND user_id = ?").run(
      accountId,
      userId,
    );
    return { action: "deactivated", id: accountId, transactions_kept: uses };
  }

  if (action === "default") {
    // Same bug as `rm`, one step worse: with no `--name` the lookup came back
    // undefined and reading `.name` off it threw a raw TypeError into the chat.
    if (!name) throw new FinError("Informe --name.");
    const accountId = resolveAccount(db, userId, name, false);
    if (accountId === null) throw new FinError("Informe --name.");
    const row = db
      .prepare("SELECT name FROM accounts WHERE id = ? AND user_id = ?")
      .get(accountId, userId) as { name: string } | undefined;
    if (!row) throw new FinError(`Conta ${JSON.stringify(name)} não existe.`);
    setSetting(db, userId, "default_account", row.name);
    return { action: "default_set", name: row.name };
  }

  return cmdBalance(db, userId);
}

export function cmdCategory(
  db: Db,
  userId: number,
  a: Args,
  positionals: string[],
): Output {
  const action = positionals[0] ?? "list";
  const name = str(a, "name");

  if (action === "add") {
    if (!name) throw new FinError("Informe --name.");
    const parentId = str(a, "parent")
      ? resolveCategory(db, userId, str(a, "parent"))
      : null;
    try {
      const info = db
        .prepare(
          "INSERT INTO categories (user_id, name, parent_id, type, emoji) VALUES (?,?,?,?,?)",
        )
        .run(
          userId,
          name.trim(),
          parentId,
          str(a, "type") ?? "expense",
          str(a, "emoji") ?? null,
        );
      const id = Number(info.lastInsertRowid);
      return { action: "created", id, name: fullCategoryName(db, userId, id) };
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) {
        throw new FinError("Essa categoria já existe nesse nível.");
      }
      throw e;
    }
  }

  if (action === "rm") {
    // Required, for the same reason as `account rm`: no name meant a NULL id, no
    // rows updated and a cheerful `ok: true`.
    if (!name) throw new FinError("Informe --name.");
    const categoryId = resolveCategory(db, userId, name);
    if (categoryId === null) throw new FinError("Informe --name.");
    db.prepare("UPDATE categories SET active = 0 WHERE id = ? AND user_id = ?").run(
      categoryId,
      userId,
    );
    return { action: "deactivated", id: categoryId };
  }

  const rows = db
    .prepare(
      "SELECT c.id, c.name, c.type, c.emoji, c.parent_id, p.name AS parent " +
        "FROM categories c LEFT JOIN categories p ON p.id = c.parent_id " +
        "WHERE c.user_id = ? AND c.active = 1 " +
        "ORDER BY COALESCE(p.name, c.name), (c.parent_id IS NOT NULL), c.name",
    )
    .all(userId) as {
    id: number;
    name: string;
    type: string;
    emoji: string | null;
    parent_id: number | null;
    parent: string | null;
  }[];

  const tree: Record<
    string,
    { id: number | null; emoji: string | null; type: string | null; children: string[] }
  > = {};

  for (const r of rows) {
    if (r.parent_id === null) {
      tree[r.name] ??= { id: r.id, emoji: r.emoji, type: r.type, children: [] };
      tree[r.name].id = r.id;
      tree[r.name].emoji = r.emoji;
      tree[r.name].type = r.type;
    } else {
      const parent = r.parent!;
      tree[parent] ??= { id: null, emoji: null, type: null, children: [] };
      tree[parent].children.push(r.name);
    }
  }

  return { count: rows.length, categories: tree };
}

function advance(iso: string, frequency: string): string {
  if (frequency === "weekly") return addDays(iso, 7);
  if (frequency === "yearly") return addMonths(iso, 12);
  return addMonths(iso, 1);
}

/** The first upcoming (or today's) occurrence of a recurring entry. */
function nextOccurrence(frequency: string, day: number): string {
  const ref = today();
  const [year, month, dayToday] = ref.split("-").map(Number);

  if (frequency === "weekly") {
    // `day` = 0..6 (Monday..Sunday)
    const weekdayToday = (new Date(`${ref}T00:00:00Z`).getUTCDay() + 6) % 7;
    return addDays(ref, (day - weekdayToday + 7) % 7);
  }
  if (frequency === "yearly") return ref;

  const target = Math.min(Math.max(1, day), lastDayOfMonth(year, month));
  const thisMonth = `${year}-${String(month).padStart(2, "0")}-${String(target).padStart(2, "0")}`;
  return target >= dayToday ? thisMonth : addMonths(thisMonth, 1);
}

export function cmdRecurring(
  db: Db,
  userId: number,
  a: Args,
  positionals: string[],
): Output {
  const action = positionals[0] ?? "list";

  if (action === "add") {
    const description = str(a, "description");
    if (!description) throw new FinError("Informe --description.");
    const amount = parseAmount(str(a, "amount"));
    const frequency = str(a, "frequency") ?? "monthly";
    const day = int(a, "day") ?? 1;
    const next = nextOccurrence(frequency, day);
    const autoDebit = flag(a, "auto-debit");

    const info = db
      .prepare(
        "INSERT INTO recurring (user_id, description, type, amount_cents, category_id," +
          " account_id, frequency, day, next_date, ends_on, auto_debit, created_at)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        userId,
        description.trim(),
        str(a, "type") ?? "expense",
        amount,
        resolveCategory(db, userId, str(a, "category"), true),
        resolveAccount(db, userId, str(a, "account")),
        frequency,
        day,
        next,
        str(a, "ends") ? parseDate(str(a, "ends")) : null,
        autoDebit ? 1 : 0,
        now(),
      );

    return {
      action: "created",
      id: Number(info.lastInsertRowid),
      description: description.trim(),
      amount_fmt: formatMoney(amount),
      next_date: next,
      auto_debit: autoDebit,
    };
  }

  if (action === "rm") {
    const id = int(a, "id");
    if (id === undefined) throw new FinError("Informe --id.");
    const info = db
      .prepare("UPDATE recurring SET active = 0 WHERE id = ? AND user_id = ?")
      .run(id, userId);
    if (!Number(info.changes)) throw new FinError(`Não achei a recorrência #${id}.`);
    return { action: "deactivated", id };
  }

  if (action === "apply") {
    // Idempotent per (recurring, date): running twice in the same day does not
    // duplicate the rent.
    //
    // Scoped to the caller, like everything else — cron fans out over
    // `auth users` and calls this once per person, so that one broken entry
    // cannot stop the other person's fixed costs from being posted.
    //
    // What changed with migration 3: the occurrence is only born `paid` when the
    // money leaves on its own — `auto_debit`, or an income (nobody has to "pay"
    // their salary in). Everything else lands `pending`: it is due, it counts
    // against the month's budget, and it stays out of the balance until
    // `recurring pay`.
    const todayIso = today();
    const due = db
      .prepare(
        "SELECT * FROM recurring WHERE user_id = ? AND active = 1 AND next_date <= ? " +
          "AND (ends_on IS NULL OR next_date <= ends_on)",
      )
      .all(userId, todayIso) as {
      id: number;
      type: string;
      amount_cents: number;
      description: string;
      category_id: number | null;
      account_id: number | null;
      frequency: string;
      day: number;
      next_date: string;
      ends_on: string | null;
      auto_debit: number;
    }[];

    const generated: Output[] = [];
    const ts = now();

    for (const r of due) {
      const paid = r.auto_debit === 1 || r.type === "income";
      let date = r.next_date;
      // Walk forward to today, covering the case of the bot being down for days.
      while (date <= todayIso) {
        if (r.ends_on && date > r.ends_on) break;
        const exists = db
          .prepare(
            "SELECT 1 FROM transactions WHERE user_id = ? AND recurring_id = ? AND date = ?",
          )
          .get(userId, r.id, date);
        if (!exists) {
          const info = db
            .prepare(
              "INSERT INTO transactions (user_id, type, amount_cents, description, date," +
                " category_id, account_id, source, recurring_id, status, paid_at," +
                " created_at, updated_at)" +
                " VALUES (?,?,?,?,?,?,?,'recurring',?,?,?,?,?)",
            )
            .run(
              userId,
              r.type,
              r.amount_cents,
              r.description,
              date,
              r.category_id,
              r.account_id,
              r.id,
              paid ? "paid" : "pending",
              paid ? ts : null,
              ts,
              ts,
            );
          generated.push({
            id: Number(info.lastInsertRowid),
            description: r.description,
            date,
            amount_fmt: formatMoney(r.amount_cents),
            status: paid ? "paid" : "pending",
            auto_debit: r.auto_debit === 1,
          });
        }
        date = advance(date, r.frequency);
      }
      db.prepare("UPDATE recurring SET next_date = ? WHERE id = ? AND user_id = ?").run(
        date,
        r.id,
        userId,
      );
    }

    const pendingGenerated = generated.filter((g) => g.status === "pending");
    return {
      action: "applied",
      count: generated.length,
      generated,
      pending_count: pendingGenerated.length,
      silent: generated.length === 0,
    };
  }

  if (action === "pending") {
    // "Quais contas eu ainda tenho que pagar." Oldest first, because the one that
    // has been sitting there longest is the one that matters.
    //
    // No period filter: an unpaid bill from two months ago is still unpaid, and a
    // window would hide exactly the one worth showing.
    const rows = db
      .prepare(
        "SELECT * FROM v_transactions WHERE user_id = ? AND status = 'pending' " +
          "ORDER BY date ASC, id ASC",
      )
      .all(userId) as TransactionRow[];

    const items = rows.map((r) => ({
      ...serializeTransaction(db, userId, r),
      days_overdue: daysOverdue(r.date),
      overdue: daysOverdue(r.date) > 0,
    }));
    const total = items.reduce((acc, i) => acc + i.amount_cents, 0);
    const overdue = items.filter((i) => i.overdue);

    return {
      count: items.length,
      total_cents: total,
      total_fmt: formatMoney(total),
      overdue_count: overdue.length,
      overdue_total_fmt: formatMoney(
        overdue.reduce((acc, i) => acc + i.amount_cents, 0),
      ),
      pending: items,
      silent: items.length === 0,
    };
  }

  if (action === "pay" || action === "unpay") {
    const id = Number(positionals[1]);
    if (!Number.isInteger(id)) {
      throw new FinError(`Informe o id do lançamento. Ex.: \`recurring ${action} 142\`.`);
    }
    // The ownership check is the `AND user_id = ?`, and somebody else's id gets
    // the same answer as an id that never existed — confirming that #142 belongs
    // to the other person is itself the leak.
    const row = db
      .prepare(
        "SELECT id, status, amount_cents, description, date, recurring_id" +
          " FROM transactions WHERE id = ? AND user_id = ?",
      )
      .get(id, userId) as
      | {
          id: number;
          status: TransactionStatus;
          amount_cents: number;
          description: string;
          date: string;
          recurring_id: number | null;
        }
      | undefined;
    if (!row) throw new FinError(`Não achei o lançamento #${id}.`);

    const ts = now();

    if (action === "pay") {
      if (row.status === "paid") {
        throw new FinError(`O lançamento #${id} já está pago.`);
      }
      // `--amount` because a light bill is never the same twice. `--date` records
      // *when* it was paid; the transaction keeps its due date, so a bill paid
      // late still belongs to the month it was due in — moving it would quietly
      // rewrite that month's report.
      const newAmount = str(a, "amount") ? parseAmount(str(a, "amount")) : null;
      const paidAt = str(a, "date") ? parseDate(str(a, "date")) : ts;
      const amount = newAmount ?? row.amount_cents;

      db.prepare(
        "UPDATE transactions SET status = 'paid', paid_at = ?, amount_cents = ?," +
          " updated_at = ? WHERE id = ? AND user_id = ?",
      ).run(paidAt, amount, ts, id, userId);

      const record = fetchTransaction(db, userId, id);
      const difference = amount - row.amount_cents;
      const out: Output = {
        action: "paid",
        transaction: record,
        amount_fmt: formatMoney(amount),
        paid_at: paidAt,
        amount_changed: difference !== 0,
        message:
          difference === 0
            ? `✅ ${row.description} pago: ${formatMoney(amount)}.`
            : `✅ ${row.description} pago: ${formatMoney(amount)} — ` +
              `${formatMoney(Math.abs(difference))} ${difference > 0 ? "acima" : "abaixo"} ` +
              `do previsto (${formatMoney(row.amount_cents)}).`,
      };
      if (difference !== 0) {
        out.expected_fmt = formatMoney(row.amount_cents);
        out.difference_fmt = formatMoney(difference);
      }
      if (record.category_id) {
        out.budget = budgetForCategory(db, userId, record.category_id, monthOf(record.date));
      }
      return out;
    }

    if (row.status === "pending") {
      throw new FinError(`O lançamento #${id} já está marcado como a pagar.`);
    }
    // Only an occurrence of a fixed cost can go back to pending. A one-off expense
    // typed into the chat was paid by definition, and letting it become "a pagar"
    // would take money out of the balance that is genuinely gone.
    if (row.recurring_id === null) {
      throw new FinError(
        `O lançamento #${id} não é uma conta fixa, então não tem pagamento a desfazer.`,
      );
    }
    db.prepare(
      "UPDATE transactions SET status = 'pending', paid_at = NULL, updated_at = ?" +
        " WHERE id = ? AND user_id = ?",
    ).run(ts, id, userId);
    return {
      action: "unpaid",
      transaction: fetchTransaction(db, userId, id),
      message: `↩️ ${row.description} voltou para a lista de contas a pagar.`,
    };
  }

  if (action === "due") {
    // Reads the *schedule*, not the generated occurrences, and that is the whole
    // point: the day before a bill is due there is no transaction yet — `apply`
    // only creates it once the date arrives. A reminder that waited for the row
    // would always be a day late.
    const within = int(a, "in") ?? 1;
    if (within < 0 || within > 366) {
      throw new FinError("--in precisa ser um número de dias entre 0 e 366.");
    }
    const limit = addDays(today(), within);
    const rows = db
      .prepare(
        "SELECT r.*, c.name AS category, a.name AS account FROM recurring r " +
          "LEFT JOIN categories c ON c.id = r.category_id " +
          "LEFT JOIN accounts a ON a.id = r.account_id " +
          "WHERE r.user_id = ? AND r.active = 1 AND r.next_date <= ? " +
          "AND (r.ends_on IS NULL OR r.next_date <= r.ends_on) " +
          "ORDER BY r.next_date ASC, r.id ASC",
      )
      .all(userId, limit) as Record<string, unknown>[];

    const items = rows.map((r) => {
      const dueDate = String(r.next_date);
      return {
        id: r.id,
        description: r.description,
        type: r.type,
        amount_cents: Number(r.amount_cents),
        amount_fmt: formatMoney(Number(r.amount_cents)),
        due_date: dueDate,
        due_date_fmt: shortDate(dueDate),
        days_until: Math.round(
          (Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) /
            86400000,
        ),
        auto_debit: Number(r.auto_debit) === 1,
        category: r.category ?? "Sem categoria",
        account: r.account ?? "Sem conta",
      };
    });
    const total = items.reduce((acc, i) => acc + i.amount_cents, 0);

    return {
      within_days: within,
      until: limit,
      count: items.length,
      total_cents: total,
      total_fmt: formatMoney(total),
      due: items,
      // Same convention as `alerts`: nothing to say means the agent answers
      // `[SILENT]` and the user gets no notification at all.
      silent: items.length === 0,
    };
  }

  const rows = db
    .prepare(
      "SELECT r.*, c.name AS category, a.name AS account FROM recurring r " +
        "LEFT JOIN categories c ON c.id = r.category_id " +
        "LEFT JOIN accounts a ON a.id = r.account_id " +
        "WHERE r.user_id = ? AND r.active = 1 ORDER BY r.next_date",
    )
    .all(userId) as Record<string, unknown>[];

  let monthlyTotal = 0;
  const items = rows.map((r) => {
    if (r.frequency === "monthly" && r.type === "expense") {
      monthlyTotal += Number(r.amount_cents);
    }
    return { ...r, amount_fmt: formatMoney(Number(r.amount_cents)) };
  });

  return {
    count: items.length,
    monthly_fixed_total_fmt: formatMoney(monthlyTotal),
    recurring: items,
  };
}

function listGoals(db: Db, userId: number): Output[] {
  const rows = db
    .prepare(
      "SELECT * FROM goals WHERE user_id = ? AND active = 1 " +
        "ORDER BY deadline IS NULL, deadline",
    )
    .all(userId) as {
    id: number;
    name: string;
    target_cents: number;
    saved_cents: number;
    deadline: string | null;
  }[];

  return rows.map((g) => {
    const pct = Math.round((g.saved_cents * 1000) / g.target_cents) / 10;
    const missing = g.target_cents - g.saved_cents;
    const item: Output = {
      id: g.id,
      name: g.name,
      target_fmt: formatMoney(g.target_cents),
      saved_fmt: formatMoney(g.saved_cents),
      missing_fmt: formatMoney(missing),
      pct,
      deadline: g.deadline,
      done: pct >= 100,
    };
    if (g.deadline) {
      const days = Math.round(
        (Date.parse(`${g.deadline}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) /
          86400000,
      );
      item.days_left = days;
      if (days > 0 && pct < 100) {
        item.monthly_needed_fmt = formatMoney(Math.trunc(missing / Math.max(1, days / 30)));
      }
    }
    return item;
  });
}

export function cmdGoal(
  db: Db,
  userId: number,
  a: Args,
  positionals: string[],
): Output {
  const action = positionals[0] ?? "list";
  const name = str(a, "name");

  if (action === "add") {
    if (!name) throw new FinError("Informe --name.");
    const target = parseAmount(str(a, "target"));
    try {
      const info = db
        .prepare(
          "INSERT INTO goals (user_id, name, target_cents, saved_cents, deadline, created_at)" +
            " VALUES (?,?,?,?,?,?)",
        )
        .run(
          userId,
          name.trim(),
          target,
          str(a, "initial") ? parseAmount(str(a, "initial")) : 0,
          str(a, "deadline") ? parseDate(str(a, "deadline")) : null,
          now(),
        );
      return { action: "created", id: Number(info.lastInsertRowid), target_fmt: formatMoney(target) };
    } catch (e) {
      if (String((e as Error).message).includes("UNIQUE")) {
        throw new FinError("Já existe uma meta com esse nome.");
      }
      throw e;
    }
  }

  if (action === "deposit") {
    const amount = parseAmount(str(a, "amount"));
    const row = db
      .prepare(
        "SELECT * FROM goals WHERE user_id = ? AND name = ? COLLATE NOCASE AND active = 1",
      )
      .get(userId, name ?? "") as { id: number; name: string } | undefined;
    if (!row) throw new FinError(`Não achei a meta ${JSON.stringify(name)}.`);
    db.prepare(
      "UPDATE goals SET saved_cents = saved_cents + ? WHERE id = ? AND user_id = ?",
    ).run(amount, row.id, userId);
    return {
      action: "deposited",
      goal: row.name,
      deposit_fmt: formatMoney(amount),
      goals: listGoals(db, userId),
    };
  }

  if (action === "rm") {
    const info = db
      .prepare(
        "UPDATE goals SET active = 0 WHERE user_id = ? AND name = ? COLLATE NOCASE",
      )
      .run(userId, name ?? "");
    if (!Number(info.changes)) {
      throw new FinError(`Não achei a meta ${JSON.stringify(name)}.`);
    }
    return { action: "removed", name };
  }

  return { goals: listGoals(db, userId) };
}

/** `paid` / `pending` as the user reads them in a spreadsheet. */
const statusLabel = (status: TransactionStatus): string =>
  status === "pending" ? "a pagar" : "pago";

function csvField(value: unknown): string {
  const s = String(value ?? "");
  return /[;"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * Exports the period's transactions.
 *
 * CSV uses `;` and a decimal comma, written UTF-8 with a BOM: that is what makes
 * Excel in Portuguese open it with the right columns and the numbers recognised
 * as numbers, with no import step.
 */
export function cmdExport(db: Db, userId: number, a: Args, dbPath: string): Output {
  const p = periodRange(str(a, "period") ?? "month");
  const format = str(a, "format") ?? "csv";
  if (!["csv", "json", "md"].includes(format)) {
    throw new FinError(`Formato inválido: ${format}. Use csv, json ou md.`);
  }

  const items = (
    db
      .prepare(
        "SELECT * FROM v_transactions WHERE user_id = ? AND date BETWEEN ? AND ? " +
          "ORDER BY date, id",
      )
      .all(userId, p.start, p.end) as TransactionRow[]
  ).map((r) => serializeTransaction(db, userId, r));

  // `--dest` used to be used verbatim, so `--dest ../../somewhere` wrote a file
  // with every one of somebody's transactions in it wherever the caller liked.
  // It now has to land inside the database's own directory — the same place the
  // backups and the default `exports/` live, and the only directory this process
  // has any business writing to.
  //
  // A guardrail, not a boundary: the agent has a shell and could write the file
  // itself. What it stops is `export --dest <anywhere>` being a one-command way to
  // stage a copy of the ledger somewhere it can be picked up.
  const dataDir = resolve(dirname(resolve(dbPath)));
  const destDir = resolve(str(a, "dest") ?? join(dataDir, "exports"));
  if (destDir !== dataDir && !destDir.startsWith(dataDir + sep)) {
    throw new FinError(
      "Só consigo exportar para dentro da pasta de dados do bot. " +
        "Escolha um destino ali (ou deixe sem --dest).",
    );
  }
  mkdirSync(destDir, { recursive: true });
  // The column headers below stay Portuguese — they are what the user reads in
  // Excel — but the filename carries the product name, matching the backups.
  //
  // `u<id>` in the name because both people export into the same directory, and
  // without it the second export of the month would overwrite the first
  // person's file — and then be attached to the wrong chat. The internal id is
  // used rather than the Telegram one, which does not belong in a filename.
  const base = `tally-u${userId}-${p.start}-a-${p.end}`;

  let path: string;
  if (format === "json") {
    path = join(destDir, `${base}.json`);
    writeFileSync(path, JSON.stringify(items, null, 2), "utf8");
  } else if (format === "md") {
    path = join(destDir, `${base}.md`);
    const lines = [
      `# Lançamentos — ${fullDate(p.start)} a ${fullDate(p.end)}`,
      "",
      "| Data | Tipo | Descrição | Categoria | Conta | Valor | Situação |",
      "|---|---|---|---|---|---|---|",
      ...items.map(
        (i) =>
          `| ${fullDate(i.date)} | ${i.type} | ${i.description.replaceAll("|", "/")} ` +
          `| ${i.full_category} | ${i.account} | ${i.amount_fmt} ` +
          `| ${statusLabel(i.status)} |`,
      ),
    ];
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  } else {
    path = join(destDir, `${base}.csv`);
    const lines = [
      [
        "id", "data", "tipo", "descricao", "categoria", "subcategoria",
        "conta", "valor", "situacao", "parcela", "tags", "observacao",
      ].join(";"),
      ...items.map((i) =>
        [
          i.id,
          fullDate(i.date),
          i.type,
          i.description,
          i.parent_category ?? i.category,
          i.parent_category ? i.category : "",
          i.account,
          (i.amount_cents / 100).toFixed(2).replace(".", ","),
          // In Portuguese, like every other header in this file: it is a column
          // the user reads and filters on in Excel.
          statusLabel(i.status),
          i.installment ?? "",
          i.tags.join(", "),
          i.note ?? "",
        ]
          .map(csvField)
          .join(";"),
      ),
    ];
    // BOM + CRLF: what Excel expects.
    writeFileSync(path, `﻿${lines.join("\r\n")}\r\n`, "utf8");
  }

  return { file: path, format, period: p, count: items.length };
}

type OptionType = "string" | "boolean";

const COMMON_OPTIONS: Record<string, OptionType> = {
  amount: "string",
  description: "string",
  category: "string",
  account: "string",
  date: "string",
  type: "string",
  tags: "string",
  note: "string",
};

/**
 * `--user` is accepted by every data subcommand, but it is an override for
 * callers with no gateway session (the Makefile, cron scripts, tests). Inside a
 * session the identity comes from `HERMES_SESSION_USER_ID` and this option may
 * only repeat it. See `resolveCaller`.
 */
const SPECS: Record<string, Record<string, OptionType>> = {
  init: {},
  auth: {
    user: "string",
    code: "string",
    name: "string",
    // Minting only. `auth revoke-invite` takes the id as a positional, like `edit`.
    label: "string",
    hours: "string",
  },
  add: {
    ...COMMON_OPTIONS,
    "dest-account": "string",
    installments: "string",
    source: "string",
  },
  edit: COMMON_OPTIONS,
  rm: { group: "boolean" },
  ls: {
    period: "string",
    category: "string",
    account: "string",
    type: "string",
    status: "string",
    tag: "string",
    text: "string",
    limit: "string",
    order: "string",
  },
  search: { limit: "string" },
  balance: {},
  summary: { period: "string", "no-compare": "boolean" },
  report: {
    period: "string",
    title: "string",
    top: "string",
    "with-data": "boolean",
  },
  budget: {
    category: "string",
    limit: "string",
    month: "string",
    alert: "string",
  },
  alerts: { month: "string", mark: "boolean", repeat: "boolean" },
  account: {
    name: "string",
    type: "string",
    institution: "string",
    closing: "string",
    due: "string",
    limit: "string",
    "opening-balance": "string",
  },
  category: { name: "string", parent: "string", type: "string", emoji: "string" },
  recurring: {
    id: "string",
    description: "string",
    amount: "string",
    category: "string",
    account: "string",
    type: "string",
    frequency: "string",
    day: "string",
    ends: "string",
    date: "string",
    "auto-debit": "boolean",
    in: "string",
  },
  goal: {
    name: "string",
    target: "string",
    amount: "string",
    initial: "string",
    deadline: "string",
  },
  export: { period: "string", format: "string", dest: "string" },

  // The four below live in their own modules, so that a change to a credit-card
  // cycle or a chart cannot break the ledger. They receive the already-resolved
  // internal `users.id` — identity and authentication stay here, in one place.
  bill: {
    account: "string",
    statement: "string",
    reference: "string",
    all: "boolean",
  },
  chart: {
    type: "string",
    period: "string",
    months: "string",
    month: "string",
    out: "string",
    "no-png": "boolean",
    "with-data": "boolean",
  },
  forecast: { month: "string", "as-of": "string" },
  import: {
    file: "string",
    format: "string",
    account: "string",
    sign: "string",
    apply: "boolean",
    token: "string",
  },
};

/** Everything that reads or writes somebody's money, i.e. everything but these. */
const UNAUTHENTICATED_COMMANDS = new Set(["init", "auth"]);

// Every data subcommand accepts --user. Added here rather than in each spec so a
// new subcommand cannot be added without it.
for (const [command, spec] of Object.entries(SPECS)) {
  if (!UNAUTHENTICATED_COMMANDS.has(command)) spec.user = "string";
}

const USAGE = `Personal finance ledger, one ledger per person. Every command prints JSON.

  node fin.ts [--db PATH] <subcommand> [options]

Subcommands: ${Object.keys(SPECS).join(", ")}

Identity and access:
  Inside a Hermes session the caller is read from HERMES_SESSION_USER_ID, so
  nothing has to be passed. Outside one — this shell, the Makefile, cron — pass
  --user <telegram id> (numeric, 5-20 digits); inside a session it may only
  repeat the session's own id. Every data subcommand refuses to run until that
  person has authenticated; the refusal carries "auth_required": true.

  A code is either a per-person invite (single use, expires, minted below) or the
  shared TALLY_ACCESS_CODE, which still works. Invites are checked first. Once
  everybody has redeemed one, TALLY_ACCESS_CODE can be deleted from the
  environment and no standing secret is left anywhere.

  These are guardrails, not a security boundary: anything with a shell here can
  unset the variable or open the database directly. The boundary is the Hermes
  gateway allowlist.

  node fin.ts auth login --user 123456789 --code <code> [--name "Nome"]
  node fin.ts auth status [--user 123456789]

Operator commands (refused when a gateway session is bound — no chat can run them):
  node fin.ts auth status                    # everybody's state at once
  node fin.ts auth users                     # machine-readable, for the cron fan-out
  node fin.ts auth invite --label "Namorada" [--hours 48]
                                             # mints one code, prints it ONCE
  node fin.ts auth invites                   # status of every invite; never a code
  node fin.ts auth revoke-invite 3           # kills one that was not used yet
  node fin.ts auth revoke --user 123456789   # cuts off one person; keeps their data
  node fin.ts auth logout-all                # everybody re-enters a code; no data lost
  node fin.ts auth unlock --user 123456789   # lifts a lockout, per id and global
  node fin.ts auth adopt-legacy --user 123456789
                                             # hands the pre-multi-user ledger to a person

  revoke is the scalpel and logout-all is the panic button: one person, versus
  everybody re-authenticating. Neither deletes a single transaction.

Paid and pending:
  A fixed cost generates an occurrence when it falls due. Unless the entry is
  --auto-debit, that occurrence is "pending": it counts against the month's
  budget and stays out of the balance until it is settled.

  node fin.ts recurring pending              # what is still to pay
  node fin.ts recurring pay 142 [--amount 92,40] [--date hoje]
  node fin.ts recurring unpay 142
  node fin.ts recurring due --in 1           # from the schedule; for the reminder cron

Examples:
  node fin.ts add --amount 27 --description "Uber" --category "Uber/99"
  node fin.ts summary --period month
  node fin.ts report --period last-month --user 123456789
  node fin.ts budget set --category Alimentação --limit 500
  node fin.ts ls --period month --status pending
`;

export function main(argv: string[]): number {
  // --db is global: pull it out before choosing the subcommand's spec.
  let dbPath: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") {
      dbPath = argv[++i];
    } else if (argv[i].startsWith("--db=")) {
      dbPath = argv[i].slice(5);
    } else {
      rest.push(argv[i]);
    }
  }

  const command = rest[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  try {
    if (!(command in SPECS)) {
      throw new FinError(
        `Subcomando desconhecido: ${command}. Use um de: ${Object.keys(SPECS).join(", ")}.`,
      );
    }

    const spec = SPECS[command];
    let values: Args;
    let positionals: string[];
    try {
      const parsed = parseArgs({
        args: rest.slice(1),
        options: Object.fromEntries(
          Object.entries(spec).map(([k, t]) => [k, { type: t }]),
        ) as never,
        allowPositionals: true,
        strict: true,
      });
      values = parsed.values as Args;
      positionals = parsed.positionals;
    } catch (e) {
      // Turn parseArgs' technical error into something the agent can act on and
      // relay to the user.
      throw new FinError(
        `${(e as Error).message}. Opções aceitas em \`${command}\`: ` +
          `${Object.keys(spec).map((k) => `--${k}`).join(", ") || "nenhuma"}.`,
      );
    }

    const target = dbPath ?? process.env.TALLY_DB;
    let output: Output;

    if (command === "init") {
      output = init(target) as unknown as Output;
    } else {
      const db = connect(target);
      try {
        // Auto-migrate: any command works against a fresh database, with no
        // manual `init` first. Seeding is no longer part of this — the taxonomy
        // belongs to a user, and it is created when that user registers.
        if (currentVersion(db) < CURRENT_SCHEMA_VERSION) migrate(db);

        if (command === "auth") {
          output = cmdAuth(db, values, positionals);
        } else {
          // The single gate. Everything below this line already knows who it is
          // acting for and gets an internal user id, never a Telegram one.
          const uid = requireUser(db, values).id;

          switch (command) {
            case "add": output = cmdAdd(db, uid, values); break;
            case "edit": output = cmdEdit(db, uid, values, positionals); break;
            case "rm": output = cmdRm(db, uid, values, positionals); break;
            case "ls": output = cmdLs(db, uid, values); break;
            case "search": output = cmdSearch(db, uid, values, positionals); break;
            case "balance": output = cmdBalance(db, uid); break;
            case "summary": output = cmdSummary(db, uid, values); break;
            case "report": output = cmdReport(db, uid, values); break;
            case "budget": output = cmdBudget(db, uid, values, positionals); break;
            case "alerts": output = cmdAlerts(db, uid, values); break;
            case "account": output = cmdAccount(db, uid, values, positionals); break;
            case "category": output = cmdCategory(db, uid, values, positionals); break;
            case "recurring": output = cmdRecurring(db, uid, values, positionals); break;
            case "goal": output = cmdGoal(db, uid, values, positionals); break;
            case "export":
              output = cmdExport(db, uid, values, target ?? "/opt/data/finance/tally.db");
              break;

            // Delegated to the modules. They never resolve identity themselves —
            // `uid` arrives already authenticated, which is the whole reason the
            // gate lives in one file instead of five.
            case "bill":
              output = cmdBill(db, uid, values);
              break;
            case "forecast":
              output = cmdForecast(db, uid, values);
              break;
            case "chart":
              output = buildChart(db, uid, str(values, "type") ?? "category", {
                period: str(values, "period"),
                months: str(values, "months") ? int(values, "months") : undefined,
                month: str(values, "month"),
                out: str(values, "out"),
                dbPath: target ?? DEFAULT_DB,
                png: !flag(values, "no-png"),
                withData: flag(values, "with-data"),
              }) as unknown as Output;
              break;
            case "import": {
              const file = str(values, "file");
              if (!file) throw new FinError("Informe --file com o caminho do extrato.");
              const opts = {
                file,
                format: str(values, "format") as "ofx" | "csv" | "auto" | undefined,
                account: str(values, "account"),
                sign: str(values, "sign") as never,
                token: str(values, "token"),
              };
              // Without --apply this only previews: nothing is written, and the
              // agent shows the person what would come in before it does.
              output = (
                flag(values, "apply")
                  ? applyImport(db, uid, opts)
                  : previewImport(db, uid, opts)
              ) as unknown as Output;
              break;
            }

            default:
              throw new FinError(`Subcomando não implementado: ${command}.`);
          }
        }
      } finally {
        db.close();
      }
    }

    process.stdout.write(`${JSON.stringify({ ok: true, ...output }, null, 2)}\n`);
    return 0;
  } catch (e) {
    const message =
      e instanceof FinError
        ? e.message
        : `Erro inesperado: ${(e as Error).message ?? String(e)}`;
    const body: Output = { ok: false, error: message };
    // The flag the agent keys on to start the code flow. Checked before the
    // generic FinError branch above, since AuthRequiredError is one of those.
    if (e instanceof AuthRequiredError) body.auth_required = true;
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return 1;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}

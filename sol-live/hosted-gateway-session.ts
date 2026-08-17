import puppeteer, { type Browser, type Page } from 'puppeteer';
import { BotSDK } from '../../sdk/index.js';
import type { BotAction, BotWorldState } from './src/bot/types.js';

type TickCallback = (() => void) | null;

type HostedGatewayOptions = {
  host: string;
  username: string;
  password: string;
  quiet?: boolean;
};

const actionFailure = (message: string, reason = 'unsupported_action') => ({ success: false, message, reason, phase: 'validation' });
const actionSuccess = (message: string) => ({ success: true, message, phase: 'dispatch' });

function normalizedHost(value: string): string {
  const raw = String(value || '').trim().replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '').replace(/\/$/, '');
  if (!raw || !/^[a-z0-9.-]+(?::\d+)?$/i.test(raw)) throw new Error('Invalid hosted rs-sdk game host');
  return raw;
}

/**
 * Hosted rs-sdk worlds require the browser bot client plus the SDK gateway.
 * This wrapper deliberately presents the same narrow transport surface used by
 * Sol's supervisor, keeping cognition, validation, and teacher controls host-agnostic.
 */
export class HostedGatewayClient {
  private readonly sdk: BotSDK;
  private readonly browser: Browser;
  private readonly page: Page;
  private tickCallback: TickCallback = null;
  private unsubscribeState: (() => void) | null = null;
  private closed = false;

  private constructor(sdk: BotSDK, browser: Browser, page: Page) {
    this.sdk = sdk;
    this.browser = browser;
    this.page = page;
  }

  static async connect(options: HostedGatewayOptions): Promise<{ client: HostedGatewayClient; stop: () => Promise<void>; stopped: Promise<{ reason: string }> }> {
    const host = normalizedHost(options.host);
    const executablePath = process.env.SOL_BROWSER_PATH?.trim() || undefined;
    const browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      protocolTimeout: 120_000,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 765, height: 503 });
    page.on('pageerror', (error) => console.warn('HOSTED_BOT_PAGE_ERROR', String(error).slice(0, 500)));
    page.on('error', (error) => console.warn('HOSTED_BOT_PAGE_CRASH', String(error).slice(0, 500)));
    page.on('console', (message) => {
      if (message.type() === 'error') console.warn('HOSTED_BOT_CONSOLE_ERROR', message.text().slice(0, 500));
    });

    const clientUrl = `https://${host}/bot?bot=${encodeURIComponent(options.username)}&password=${encodeURIComponent(options.password)}`;
    try {
      await page.goto(clientUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const sdk = new BotSDK({
        botUsername: options.username,
        password: options.password,
        gatewayUrl: `wss://${host}/gateway`,
        connectionMode: 'control',
        autoLaunchBrowser: false,
        autoReconnect: true,
        connectTimeout: 45_000,
        readyTimeout: 60_000,
        showChat: true,
      });
      const adapter = new HostedGatewayClient(sdk, browser, page);
      await sdk.connect();
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (sdk.getState()?.player) {
          if (!options.quiet) console.log('HOSTED_GATEWAY_READY', { host, username: options.username });
          return { client: adapter, stop: () => adapter.stop(), stopped: adapter.waitUntilStopped() };
        }
        await Bun.sleep(500);
      }
      throw new Error('Hosted gateway authenticated but the bot client did not produce game state before timeout');
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }

  setOnGameTickCallback(callback: TickCallback): void {
    this.tickCallback = callback;
    this.unsubscribeState?.();
    this.unsubscribeState = callback ? this.sdk.onStateUpdate(() => {
      try { this.tickCallback?.(); } catch (error) { console.error('HOSTED_GATEWAY_TICK_CALLBACK_ERROR', error); }
    }) : null;
  }

  collectBotState(_tick: number): BotWorldState | null {
    return this.sdk.getState() as BotWorldState | null;
  }

  async executeBotAction(action: BotAction | any): Promise<any> {
    try {
      switch (action?.type) {
        case 'none': return actionSuccess('No action');
        case 'wait': return actionSuccess(`Waiting ${Number(action.ticks || 1)} ticks`);
        case 'walkTo': return await this.sdk.sendWalk(Number(action.x), Number(action.z), action.running !== false);
        case 'talkToNpc': return await this.sdk.sendTalkToNpc(Number(action.npcIndex));
        case 'interactNpc': return await this.sdk.sendInteractNpc(Number(action.npcIndex), Number(action.optionIndex));
        case 'interactPlayer': return await this.sdk.sendInteractPlayer(Number(action.playerIndex), Number(action.optionIndex));
        case 'interactLoc': return await this.sdk.sendInteractLoc(Number(action.x), Number(action.z), Number(action.locId), Number(action.optionIndex));
        case 'pickupItem': return await this.sdk.sendPickup(Number(action.x), Number(action.z), Number(action.itemId));
        case 'useInventoryItem': return await this.sdk.sendUseItem(Number(action.slot), Number(action.optionIndex), action.interfaceId === undefined ? undefined : Number(action.interfaceId));
        case 'dropItem': return await this.sdk.sendDropItem(Number(action.slot));
        case 'useItemOnItem': return await this.sdk.sendUseItemOnItem(Number(action.sourceSlot), Number(action.targetSlot));
        case 'useItemOnLoc': return await this.sdk.sendUseItemOnLoc(Number(action.itemSlot), Number(action.x), Number(action.z), Number(action.locId));
        case 'useItemOnNpc': return await this.sdk.sendUseItemOnNpc(Number(action.itemSlot), Number(action.npcIndex));
        case 'clickDialogOption': return await this.sdk.sendClickDialog(Number(action.optionIndex));
        case 'clickComponent': return await this.sdk.sendClickComponent(Number(action.componentId));
        case 'clickComponentWithOption': return await this.sdk.sendClickComponentWithOption(Number(action.componentId), Number(action.optionIndex), Number(action.slot || 0));
        case 'useEquipmentItem': return await this.sdk.sendUseEquipmentItem(Number(action.slot), Number(action.optionIndex));
        case 'shopBuy': return await this.sdk.sendShopBuy(Number(action.slot), Number(action.amount || 1));
        case 'shopSell': return await this.sdk.sendShopSell(Number(action.slot), Number(action.amount || 1));
        case 'closeShop': return await this.sdk.sendCloseShop();
        case 'closeModal': return await this.sdk.sendCloseModal();
        case 'setCombatStyle': return await this.sdk.sendSetCombatStyle(Number(action.style));
        case 'spellOnNpc': return await this.sdk.sendSpellOnNpc(Number(action.npcIndex), Number(action.spellComponent));
        case 'spellOnPlayer': return await this.sdk.sendSpellOnPlayer(Number(action.playerIndex), Number(action.spellComponent));
        case 'spellOnItem': return await this.sdk.sendSpellOnItem(Number(action.slot), Number(action.spellComponent));
        case 'spellOnGroundItem': return await this.sdk.sendSpellOnGroundItem(Number(action.x), Number(action.z), Number(action.itemId), Number(action.spellComponent));
        case 'setTab': return await this.sdk.sendSetTab(Number(action.tabIndex));
        case 'say': return await this.sdk.sendSay(String(action.message || ''));
        case 'bankDeposit': return await this.sdk.sendBankDeposit(Number(action.slot), Number(action.amount ?? 1));
        case 'bankWithdraw': return await this.sdk.sendBankWithdraw(Number(action.slot), Number(action.amount ?? 1));
        default: return actionFailure(`Hosted gateway adapter does not support ${String(action?.type || 'unknown')}`);
      }
    } catch (error) {
      return actionFailure(String(error), 'gateway_execution_error');
    }
  }

  private async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.setOnGameTickCallback(null);
    await this.sdk.disconnect().catch(() => {});
    await this.page.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  private async waitUntilStopped(): Promise<{ reason: string }> {
    while (!this.closed) await Bun.sleep(500);
    return { reason: 'stopped' };
  }
}

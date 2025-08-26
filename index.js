import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import axios from 'axios';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';


const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const token = process.env.BOT_TOKEN;
const channelId = process.env.CHANNEL_ID;

const adapter = new JSONFile('./db/db.json');
const db = new Low(adapter, { sentPacketIds: [] });

// In-memory cache for node info
const nodeCache = new Map();
const NODE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

let writePromise = Promise.resolve();

function queueDbWrite() {
  writePromise = writePromise.then(() => db.write()).catch(console.error);
  return writePromise;
}

client.once('clientReady', async () => {
  console.log(`[ready] Logged in as ${client.user?.tag} (id=${client.user?.id})`);

  // Initialize the database
  try {
    await db.read();
    if (!db.data) db.data = {};
    // Ensure schema
    if (!Array.isArray(db.data.sentPacketIds)) db.data.sentPacketIds = [];
    if (!Array.isArray(db.data.alertsSubscriptions)) db.data.alertsSubscriptions = [];
    if (!db.data.alertsState) db.data.alertsState = {}; // key: userId|nodeId|event -> { status, lastAlertMs }
    if (!db.data.perNodeSnapshots) db.data.perNodeSnapshots = {}; // key: nodeId -> { lastUptimeSeconds, lastBatteryLevel, lastUpdatedAt }
    if (!db.data.alertsMeta) db.data.alertsMeta = { hourStartMs: Date.now(), sentInHour: 0 };
    console.log('Database initialized successfully');
  } catch (error) {
    console.log('Database file not found, creating new one');
    db.data = {
      sentPacketIds: [],
      alertsSubscriptions: [],
      alertsState: {},
      perNodeSnapshots: {},
      alertsMeta: { hourStartMs: Date.now(), sentInHour: 0 }
    };
    await db.write();
  }

  // Register slash commands per guild
  await registerAlertsCommands();
  console.log(`[ready] Registered commands for ${client.guilds.cache.size} guild(s)`);

  // Start pollers
  fetchAndPostMessages(); // Initial run
  setInterval(fetchAndPostMessages, 30000); // Every 30 sec
  setInterval(runAlertsPoller, 120000); // Every 120 sec
});

async function fetchAndPostMessages() {
  try {
    const channel = await client.channels.fetch(channelId);
    const url = 'https://map.sthlm-mesh.se/api/v1/text-messages?order=desc&count=10';
    const { data } = await axios.get(url);

    const uniqueMessages = Array.from(new Map(data.text_messages.map(msg => [msg.packet_id, msg])).values());
    const newMessages = uniqueMessages.filter(msg => !db.data.sentPacketIds.includes(msg.packet_id));

    for (const msg of newMessages.reverse()) {
      const [fromNode, toNode] = await Promise.all([
        fetchNodeInfo(msg.from),
        fetchNodeInfo(msg.to)
      ]);

      const isBroadcast = msg.to === "4294967295";
      const fromName = formatNode(fromNode, msg.from);
      const toName = isBroadcast ? "All" : formatNode(toNode, msg.to);


      const embed = new EmbedBuilder()
      .setColor(isBroadcast ? 0x3498db : 0xe67e22) // Blue for broadcast, orange for direct
      .setDescription(fromName + (isBroadcast ? '' : ' → ' + toName))
      .addFields({ 
        name: msg.text || '*[no text]*',
        value: ''  
      })
      .setFooter({ text: `Channel: ${msg.channel_id}` })
      .setTimestamp(new Date(msg.created_at));

      await channel.send({ embeds: [embed] });
      db.data.sentPacketIds.push(msg.packet_id);
    }

    db.data.sentPacketIds = db.data.sentPacketIds.slice(-100);
    
    //await db.write();
    await queueDbWrite();

  } catch (err) {
    console.error('Error fetching/posting messages:', err.message);
  }
}

async function fetchNodeInfo(nodeId) {
    if (nodeId === "4294967295") return null;
  
    const cached = nodeCache.get(nodeId);
    const now = Date.now();
  
    if (cached && (now - cached.timestamp < NODE_CACHE_TTL_MS)) {
      return cached.data;
    }
  
    try {
      const url = `https://map.sthlm-mesh.se/api/v1/nodes/${nodeId}`;
      const { data } = await axios.get(url);
      const node = data.node;
      if (node) {
        nodeCache.set(nodeId, {
          data: node,
          timestamp: now
        });
      }
      return node;
    } catch (err) {
      console.warn(`Failed to fetch node ${nodeId}: ${err.message}`);
      return cached?.data ?? null; // fallback to stale cache if available
    }
  }
  

function formatNode(node, fallbackId) {
  if (!node) return `!${parseInt(fallbackId).toString(16)}`;
  return node.short_name ? `[${node.short_name}] ${node.long_name}` : node.long_name;
}

function formatTimestamp(iso) {
  const date = new Date(iso);
  return date.toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
}

// Helpers for alerts
function normalizeNodeId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (trimmed.startsWith('!')) {
    const hex = trimmed.slice(1).replace(/^0+/, '');
    const dec = parseInt(hex || '0', 16);
    if (Number.isNaN(dec)) return null;
    return String(dec);
  }
  const dec = parseInt(trimmed, 10);
  if (Number.isNaN(dec)) return null;
  return String(dec);
}

function toHexBang(decString) {
  try {
    const n = parseInt(decString, 10);
    if (Number.isNaN(n)) return `!${decString}`;
    return `!${n.toString(16)}`;
  } catch {
    return `!${decString}`;
  }
}

function parseDurationToMinutes(input, defaultMinutes) {
  if (!input) return defaultMinutes;
  const s = String(input).trim().toLowerCase();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^([0-9]+)\s*(m|h|d)$/);
  if (!m) return defaultMinutes;
  const value = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === 'm') return value;
  if (unit === 'h') return value * 60;
  if (unit === 'd') return value * 1440;
  return defaultMinutes;
}

function ensureHourWindow(meta) {
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  if (!meta.hourStartMs || now - meta.hourStartMs >= hourMs) {
    meta.hourStartMs = now;
    meta.sentInHour = 0;
  }
}

async function registerAlertsCommands() {
  const commands = [
    {
      name: 'alerts',
      description: 'Manage Meshtastic alerts',
      options: [
        {
          type: 1, // SUB_COMMAND
          name: 'subscribe',
          description: 'Subscribe to alerts for a node',
          options: [
            { type: 3, name: 'node', description: 'node id or !hex', required: true },
            { type: 3, name: 'events', description: 'battery,offline,reboot (comma-separated)', required: false },
            { type: 4, name: 'battery', description: 'battery percent threshold (default 50)', required: false },
            { type: 3, name: 'offline', description: 'offline window like 90|2h|1d (default 1d)', required: false }
          ]
        },
        {
          type: 1,
          name: 'unsubscribe',
          description: 'Unsubscribe from alerts for a node',
          options: [
            { type: 3, name: 'node', description: 'node id or !hex', required: true },
            { type: 3, name: 'events', description: 'battery,offline,reboot; omit to remove all', required: false }
          ]
        },
        {
          type: 1,
          name: 'list',
          description: 'List your alert subscriptions'
        },
        {
          type: 1,
          name: 'test',
          description: 'Send a test alert DM for a node',
          options: [
            { type: 3, name: 'node', description: 'node id or !hex', required: true }
          ]
        }
      ]
    }
  ];

  for (const guild of client.guilds.cache.values()) {
    try {
      console.log(`[commands] Registering in guild ${guild.id} (${guild.name}) as ${client.user?.tag}`);
      await guild.commands.set(commands);
      console.log(`[commands] Registered /alerts in guild ${guild.name}`);
    } catch (err) {
      console.error('Failed to register commands for guild', guild.id, err.message);
    }
  }
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    console.log(`[interaction] ${interaction.user.tag} used /${interaction.commandName} in ${interaction.guild?.id} (${interaction.guild?.name || 'DM'})`);
    if (interaction.commandName !== 'alerts') return;

    const sub = interaction.options.getSubcommand();
    console.log(`[interaction] Handling /alerts ${sub} by ${interaction.user.id} in guild ${interaction.guildId}`);
    if (sub === 'subscribe') {
      const nodeInput = interaction.options.getString('node', true);
      const eventsInput = interaction.options.getString('events');
      const batteryInput = interaction.options.getInteger('battery');
      const offlineInput = interaction.options.getString('offline');

      const nodeId = normalizeNodeId(nodeInput);
      console.log(`[interaction] subscribe nodeInput=${nodeInput} -> nodeId=${nodeId}`);
      if (!nodeId) {
        await interaction.reply({ content: 'Invalid node id. Use decimal or !hex.', ephemeral: true });
        return;
      }

      // Validate node exists
      const node = await fetchNodeInfo(nodeId);
      if (!node) {
        await interaction.reply({ content: `Node ${toHexBang(nodeId)} not found.`, ephemeral: true });
        return;
      }

      const userId = interaction.user.id;
      const perUserNodes = new Set(db.data.alertsSubscriptions.filter(s => s.userId === userId).map(s => s.nodeId));
      if (!perUserNodes.has(nodeId) && perUserNodes.size >= 20) {
        await interaction.reply({ content: 'You reached the max of 20 watched nodes.', ephemeral: true });
        return;
      }

      let events = { battery: true, offline: true, reboot: true };
      if (eventsInput) {
        const set = new Set(eventsInput.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
        events = { battery: set.has('battery'), offline: set.has('offline'), reboot: set.has('reboot') };
        if (!events.battery && !events.offline && !events.reboot) {
          await interaction.reply({ content: 'No valid events specified. Use battery,offline,reboot.', ephemeral: true });
          return;
        }
      }

      const battery = typeof batteryInput === 'number' ? batteryInput : 50;
      const offlineMinutes = parseDurationToMinutes(offlineInput, 1440);

      // Upsert subscription
      const idx = db.data.alertsSubscriptions.findIndex(s => s.userId === userId && s.nodeId === nodeId);
      if (idx >= 0) {
        db.data.alertsSubscriptions[idx] = {
          ...db.data.alertsSubscriptions[idx],
          events,
          thresholds: { battery, offlineMinutes }
        };
      } else {
        db.data.alertsSubscriptions.push({ userId, nodeId, events, thresholds: { battery, offlineMinutes } });
      }
      await queueDbWrite();

      const nodeName = formatNode(node, nodeId);
      await interaction.reply({ content: `Subscribed to ${nodeName} (${toHexBang(nodeId)}) for events: ${Object.entries(events).filter(([, v]) => v).map(([k]) => k).join(', ')}.`, ephemeral: true });
      console.log(`[interaction] subscribe success user=${userId} node=${nodeId}`);
    }

    if (sub === 'unsubscribe') {
      const nodeInput = interaction.options.getString('node', true);
      const eventsInput = interaction.options.getString('events');
      const nodeId = normalizeNodeId(nodeInput);
      console.log(`[interaction] unsubscribe nodeInput=${nodeInput} -> nodeId=${nodeId}`);
      if (!nodeId) {
        await interaction.reply({ content: 'Invalid node id.', ephemeral: true });
        return;
      }
      const userId = interaction.user.id;

      const idx = db.data.alertsSubscriptions.findIndex(s => s.userId === userId && s.nodeId === nodeId);
      if (idx < 0) {
        await interaction.reply({ content: 'No subscription found for that node.', ephemeral: true });
        return;
      }
      if (!eventsInput) {
        db.data.alertsSubscriptions.splice(idx, 1);
      } else {
        const set = new Set(eventsInput.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
        const subRec = db.data.alertsSubscriptions[idx];
        const newEvents = {
          battery: subRec.events.battery && !set.has('battery'),
          offline: subRec.events.offline && !set.has('offline'),
          reboot: subRec.events.reboot && !set.has('reboot')
        };
        if (!newEvents.battery && !newEvents.offline && !newEvents.reboot) {
          db.data.alertsSubscriptions.splice(idx, 1);
        } else {
          subRec.events = newEvents;
        }
      }
      await queueDbWrite();
      await interaction.reply({ content: 'Unsubscribe updated.', ephemeral: true });
      console.log(`[interaction] unsubscribe success user=${userId} node=${nodeId}`);
    }

    if (sub === 'list') {
      const userId = interaction.user.id;
      const subs = db.data.alertsSubscriptions.filter(s => s.userId === userId);
      if (subs.length === 0) {
        await interaction.reply({ content: 'No subscriptions yet.', ephemeral: true });
        return;
      }
      const lines = await Promise.all(subs.map(async (s) => {
        const node = await fetchNodeInfo(s.nodeId);
        const nodeName = formatNode(node, s.nodeId);
        const evs = Object.entries(s.events).filter(([, v]) => v).map(([k]) => k).join(', ');
        return `${nodeName} (${toHexBang(s.nodeId)}) — [${evs}] batt<${s.thresholds.battery} offline>${s.thresholds.offlineMinutes}m`;
      }));
      await interaction.reply({ content: lines.join('\n'), ephemeral: true });
      console.log(`[interaction] listed ${subs.length} subscription(s) for user=${userId}`);
    }

    if (sub === 'test') {
      const nodeInput = interaction.options.getString('node', true);
      const nodeId = normalizeNodeId(nodeInput);
      console.log(`[interaction] test nodeInput=${nodeInput} -> nodeId=${nodeId}`);
      if (!nodeId) {
        await interaction.reply({ content: 'Invalid node id.', ephemeral: true });
        return;
      }
      const node = await fetchNodeInfo(nodeId);
      if (!node) {
        await interaction.reply({ content: `Node ${toHexBang(nodeId)} not found.`, ephemeral: true });
        return;
      }
      await interaction.reply({ content: 'Sending test DM...', ephemeral: true });
      const embed = buildAlertEmbed('Test Alert', node, nodeId, `Sample condition for ${toHexBang(nodeId)}`);
      try {
        await interaction.user.send({ embeds: [embed] });
      } catch (err) {
        console.error('Failed to send test DM:', err.message);
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable() && !interaction.replied) {
      await interaction.reply({ content: 'Error handling command.', ephemeral: true });
    }
  }
});

const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

async function runAlertsPoller() {
  try {
    const subs = db.data.alertsSubscriptions;
    if (!subs || subs.length === 0) return;
    // Unique nodes
    const nodeIds = Array.from(new Set(subs.map(s => s.nodeId)));
    const nodes = new Map();
    await Promise.all(nodeIds.map(async (id) => {
      const node = await fetchNodeInfo(id);
      if (node) nodes.set(id, node);
    }));

    for (const sub of subs) {
      const node = nodes.get(sub.nodeId);
      if (!node) continue; // do not change state on failed fetch

      const nowMs = Date.now();
      const snapshot = db.data.perNodeSnapshots[sub.nodeId] || {};
      const results = evaluateEvents(sub, node, snapshot);

      for (const r of results) {
        await maybeSendAlert(sub.userId, sub.nodeId, node, r.event, r.message, r.isAlert, nowMs);
      }

      // Update per-node snapshot
      const curUptime = Number(node.uptime_seconds);
      db.data.perNodeSnapshots[sub.nodeId] = {
        lastUptimeSeconds: Number.isFinite(curUptime) ? curUptime : snapshot.lastUptimeSeconds,
        lastBatteryLevel: typeof node.battery_level === 'number' ? node.battery_level : snapshot.lastBatteryLevel,
        lastUpdatedAt: node.updated_at || snapshot.lastUpdatedAt
      };
      console.log(`[alerts] Updated per-node snapshot for node ${sub.nodeId}`, node);
    }

    await queueDbWrite();
  } catch (err) {
    console.error('Alert poller error:', err);
  }
}

function evaluateEvents(sub, node, snapshot) {
  const items = [];
  const name = formatNode(node, sub.nodeId);

  // Battery
  if (sub.events.battery && typeof node.battery_level === 'number') {
    const threshold = sub.thresholds?.battery ?? 50;
    const hysteresis = 5;
    const key = `${sub.userId}|${sub.nodeId}|battery`;
    const state = db.data.alertsState[key] || { status: 'normal', lastAlertMs: 0 };
    const isAlertNow = node.battery_level < threshold;
    const isRecoveryNow = node.battery_level >= (threshold + hysteresis);
    let shouldEmit = false;
    let isAlert = false;
    if (state.status !== 'alert' && isAlertNow) { shouldEmit = true; isAlert = true; }
    else if (state.status === 'alert' && isRecoveryNow) { shouldEmit = true; isAlert = false; }
    if (shouldEmit) {
      const msg = isAlert
        ? `Battery ${node.battery_level}% < ${threshold}%`
        : `Battery recovered ${node.battery_level}% ≥ ${threshold + hysteresis}%`;
      items.push({ event: 'battery', message: msg, isAlert });
    }
  }

  // Offline
  if (sub.events.offline && node.updated_at) {
    const thresholdMin = sub.thresholds?.offlineMinutes ?? 1440;
    const key = `${sub.userId}|${sub.nodeId}|offline`;
    const state = db.data.alertsState[key] || { status: 'normal', lastAlertMs: 0 };
    const minutesSince = Math.floor((Date.now() - new Date(node.updated_at).getTime()) / 60000);
    const isAlertNow = minutesSince > thresholdMin;
    const isRecoveryNow = minutesSince <= thresholdMin;
    let shouldEmit = false;
    let isAlert = false;
    if (state.status !== 'alert' && isAlertNow) { shouldEmit = true; isAlert = true; }
    else if (state.status === 'alert' && isRecoveryNow) { shouldEmit = true; isAlert = false; }
    if (shouldEmit) {
      const msg = isAlert
        ? `No updates for ${minutesSince}m > ${thresholdMin}m`
        : `Back online within ${thresholdMin}m`;
      items.push({ event: 'offline', message: msg, isAlert });
    }
  }

  // Reboot
  if (sub.events.reboot) {
    const prev = typeof snapshot.lastUptimeSeconds === 'number' ? snapshot.lastUptimeSeconds : null;
    const cur = Number(node.uptime_seconds);
    const key = `${sub.userId}|${sub.nodeId}|reboot`;
    const state = db.data.alertsState[key] || { status: 'normal', lastAlertMs: 0 };
    if (prev !== null && Number.isFinite(cur) && (prev - cur >= 300)) {
      if (state.status !== 'alert') {
        items.push({ event: 'reboot', message: `Uptime dropped from ${Math.floor(prev/60)}m to ${Math.floor(cur/60)}m`, isAlert: true });
      }
    } else if (state.status === 'alert' && prev !== null && Number.isFinite(cur) && cur > prev) {
      items.push({ event: 'reboot', message: 'Reboot acknowledged (uptime increasing).', isAlert: false });
    }
  }

  return items;
}

function buildAlertEmbed(eventTitle, node, nodeId, conditionSummary, footerEventName) {
  const isAlert = !/recovered|acknowledged/i.test(conditionSummary);
  const color = isAlert ? 0xe74c3c : 0x2ecc71;
  const title = `${eventTitle} — ${node.short_name ? `[${node.short_name}] ` : ''}${node.long_name || toHexBang(nodeId)}`;
  const nodeField = `${node.short_name ? `[${node.short_name}] ` : ''}${node.long_name || ''}\n${toHexBang(nodeId)} / ${nodeId}`.trim();
  const channelField = node.channel_id ? String(node.channel_id) : '-';
  const updatedAt = node.updated_at || '-';
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(conditionSummary)
    .addFields(
      { name: 'Node', value: nodeField, inline: false },
      { name: 'Channel', value: channelField, inline: true },
      { name: 'updated_at', value: updatedAt, inline: true }
    )
    .setFooter({ text: footerEventName || eventTitle })
    .setTimestamp(new Date());
}

async function maybeSendAlert(userId, nodeId, node, event, message, isAlert, nowMs) {
  const key = `${userId}|${nodeId}|${event}`;
  const state = db.data.alertsState[key] || { status: 'normal', lastAlertMs: 0 };

  // Cooldown for alert enters only
  if (isAlert && state.lastAlertMs && nowMs - state.lastAlertMs < COOLDOWN_MS) return;

  // Global cap
  ensureHourWindow(db.data.alertsMeta);
  if (db.data.alertsMeta.sentInHour >= 50) return;

  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;

  const eventTitle = isAlert ? `${event.toUpperCase()} alert` : `${event.toUpperCase()} recovery`;
  const embed = buildAlertEmbed(eventTitle, node, nodeId, message, event);

  try {
    await user.send({ embeds: [embed] });
    console.log(`[alerts] DM sent user=${userId} event=${event} node=${nodeId} isAlert=${isAlert}`);
    // Update state only after successful DM
    db.data.alertsState[key] = { status: isAlert ? 'alert' : 'normal', lastAlertMs: isAlert ? nowMs : state.lastAlertMs };
    db.data.alertsMeta.sentInHour += 1;
  } catch (err) {
    console.error('Failed to DM alert:', err.message);
  }
}

client.login(token);

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

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  fetchAndPostMessages(); // Initial run
  setInterval(fetchAndPostMessages, 30000); // Every 30 sec
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

client.login(token);

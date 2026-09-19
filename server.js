const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const { GridFSBucket } = require("mongodb");
const webpush = require("web-push");

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ==================== VAPID KEYS (Web Push) ====================
const VAPID_PUBLIC_KEY = "BEfP944h9mPSf9s4ZjIlNqcj02Ff8E5HFx0pKLEpajtQGCh3KMJXFIraqVb6Xx5z3c_1pV8ejtGgHJIwIMwPHWg";
const VAPID_PRIVATE_KEY = "_LGMk0-nL6NqKkM-CGBI6MOV1xqxSUWIN2e_p9mpu6s";

webpush.setVapidDetails(
  "mailto:admin@noticeboard.local",
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// In-memory store for push subscriptions (NO MongoDB changes)
const pushSubscriptions = new Set();

function addSubscription(sub) {
  const key = JSON.stringify(sub);
  pushSubscriptions.add(key);
}

function removeSubscription(sub) {
  const key = JSON.stringify(sub);
  pushSubscriptions.delete(key);
}

async function sendPushToAll(payload) {
  const dead = [];
  for (const subStr of pushSubscriptions) {
    try {
      const sub = JSON.parse(subStr);
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        dead.push(subStr);
      }
      console.error("Push error:", err.statusCode || err.message);
    }
  }
  dead.forEach((s) => pushSubscriptions.delete(s));
}

// ==================== MongoDB ====================
const MONGO_URI =
  "mongodb://notice-board-sys:notice-board-sys-sticks@ac-w5b57gt-shard-00-00.wcrralm.mongodb.net:27017,ac-w5b57gt-shard-00-01.wcrralm.mongodb.net:27017,ac-w5b57gt-shard-00-02.wcrralm.mongodb.net:27017/?ssl=true&replicaSet=atlas-q26fhi-shard-0&authSource=admin&appName=Cluster0";

let bucket;
mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB Connected");
    bucket = new GridFSBucket(mongoose.connection.db, {
      bucketName: "attachments",
    });
  })
  .catch((err) => console.error("❌ Connection Error:", err));

const NoticeSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  category: { type: String, required: true },
  author: { type: String, default: "Master Admin" },
  date: { type: Date, default: Date.now },
  fileId: mongoose.Schema.Types.ObjectId,
  fileName: String,
  fileType: String,
});

const Notice = mongoose.model("Notice", NoticeSchema);

// ==================== SSE (for live list refresh while tab open) ====================
const sseClients = new Set();

function broadcastNotice(notice) {
  const data = JSON.stringify({
    type: "new_notice",
    notice: {
      _id: notice._id,
      title: notice.title,
      content: notice.content,
      category: notice.category,
      author: notice.author,
      date: notice.date,
    },
  });

  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  res.write(": connected\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ==================== Web Push endpoints ====================
app.get("/api/vapid-public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/subscribe", (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Invalid subscription" });
  }
  addSubscription(subscription);
  console.log("New push subscription. Total:", pushSubscriptions.size);
  res.status(201).json({ success: true });
});

app.post("/api/unsubscribe", (req, res) => {
  const subscription = req.body;
  if (subscription) removeSubscription(subscription);
  res.json({ success: true });
});

// ==================== AUTH ====================
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "COMSCIENCE" && password === "COMSCI1234") {
    return res.json({ success: true });
  }
  res.status(401).json({ success: false });
});

// ==================== NOTICES ====================
app.get("/api/notices", async (req, res) => {
  try {
    const notices = await Notice.find().sort({ date: -1 });
    res.json(notices);
  } catch (err) {
    res.status(500).json({ error: "Database fetch failed" });
  }
});

app.post("/api/notices", async (req, res) => {
  try {
    const { title, content, category, author, attachment } = req.body;
    let fileId = null;

    if (attachment && attachment.data) {
      const buffer = Buffer.from(attachment.data.split(",")[1], "base64");
      const uploadStream = bucket.openUploadStream(attachment.name, {
        contentType: attachment.type,
      });
      uploadStream.end(buffer);
      fileId = uploadStream.id;
    }

    const notice = new Notice({
      title,
      content,
      category,
      author,
      fileId,
      fileName: attachment?.name,
      fileType: attachment?.type,
    });

    await notice.save();

    // Live update for open tabs
    broadcastNotice(notice);

    // Real Web Push to all subscribed devices (even if browser closed)
    const payload = {
      title: "📢 New Notice: " + notice.title,
      body: notice.content.substring(0, 120) + (notice.content.length > 120 ? "..." : ""),
      data: {
        url: "/",
        noticeId: notice._id.toString(),
      },
    };
    sendPushToAll(payload).catch(console.error);

    res.status(201).json(notice);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/notices/:id", async (req, res) => {
  try {
    const { attachment, ...otherData } = req.body;
    const existing = await Notice.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found" });

    let updateData = { ...otherData };

    if (attachment && attachment.data) {
      if (existing.fileId) {
        try {
          await bucket.delete(existing.fileId);
        } catch (e) {}
      }

      const buffer = Buffer.from(attachment.data.split(",")[1], "base64");
      const uploadStream = bucket.openUploadStream(attachment.name, {
        contentType: attachment.type,
      });
      uploadStream.end(buffer);

      updateData.fileId = uploadStream.id;
      updateData.fileName = attachment.name;
      updateData.fileType = attachment.type;
    }

    const updated = await Notice.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/notices/:id", async (req, res) => {
  try {
    const notice = await Notice.findById(req.params.id);
    if (notice && notice.fileId) {
      try {
        await bucket.delete(notice.fileId);
      } catch (e) {}
    }
    await Notice.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/files/:id", (req, res) => {
  try {
    const fileId = new mongoose.Types.ObjectId(req.params.id);
    const downloadStream = bucket.openDownloadStream(fileId);
    downloadStream.on("error", () => res.status(404).send("Not Found"));
    downloadStream.pipe(res);
  } catch (err) {
    res.status(400).send("Invalid ID");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

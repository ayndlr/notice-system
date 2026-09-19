const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const { GridFSBucket } = require("mongodb");

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

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

// ==================== SSE (Server-Sent Events) ====================
// In-memory list of connected clients (no MongoDB needed)
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
      // Client probably disconnected
      sseClients.delete(client);
    }
  }
}

// SSE endpoint - clients connect here to receive live updates
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  // Send a comment to keep connection alive
  res.write(": connected\n\n");

  sseClients.add(res);

  // Remove client when they disconnect
  req.on("close", () => {
    sseClients.delete(res);
  });
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

    // Broadcast to all connected SSE clients
    broadcastNotice(notice);

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
      // Cleanup old file from GridFS
      if (existing.fileId) {
        try {
          await bucket.delete(existing.fileId);
        } catch (e) {}
      }

      // Upload new file
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

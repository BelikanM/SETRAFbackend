require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 5000;
const MONGO_USER = process.env.MONGO_USER;
const MONGO_PASSWORD = encodeURIComponent(process.env.MONGO_PASSWORD);
const MONGO_CLUSTER = process.env.MONGO_CLUSTER;
const MONGO_DB_NAME = process.env.MONGO_DB_NAME;
const MONGO_URI = `mongodb+srv://${MONGO_USER}:${MONGO_PASSWORD}@${MONGO_CLUSTER}/${MONGO_DB_NAME}?retryWrites=true&w=majority&appName=Cluster0`;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPER_ADMIN_EMAIL = "admin@super.com";

// ---------------- EXPRESS + SOCKET ----------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000", // frontend
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------------- MULTER UPLOADS ----------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = "uploads/";
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  },
});
const upload = multer({ storage });

// ---------------- MONGOOSE MODELS ----------------
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: String,
  firstName: String,
  lastName: String,
  profilePhoto: String,
  role: { type: String, enum: ["admin", "manager", "employee"], default: "employee" },
  isVerified: { type: Boolean, default: true },
  isApproved: { type: Boolean, default: true },
  isOnline: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  content: { type: String },
  mediaUrl: { type: String }, // fichier image/vidéo/doc
  audioUrl: { type: String }, // audio
  timestamp: { type: Date, default: Date.now },
  isGroupMessage: { type: Boolean, default: true },
  isEdited: { type: Boolean, default: false },
  isDeleted: { type: Boolean, default: false }
});

const User = mongoose.model("User", userSchema);
const Message = mongoose.model("Message", messageSchema);

// ---------------- DB ----------------
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connecté"))
  .catch(err => console.error("❌ Erreur MongoDB:", err));

// ---------------- AUTH MIDDLEWARE ----------------
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Token requis" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(decoded.userId);
    if (!req.user) return res.status(401).json({ message: "Utilisateur introuvable" });
    next();
  } catch (err) {
    return res.status(403).json({ message: "Token invalide" });
  }
};

// ---------------- SOCKET.IO ----------------
io.on("connection", (socket) => {
  console.log("⚡ User connecté:", socket.id);

  socket.on("authenticate", async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.userId);
      if (!user) return;

      socket.userId = user._id.toString();
      socket.user = user;

      await User.findByIdAndUpdate(user._id, { isOnline: true, lastSeen: new Date() });

      socket.join("general");
      io.emit("user-online", {
        userId: user._id,
        firstName: user.firstName,
        lastName: user.lastName
      });
    } catch (err) {
      console.error("❌ Auth socket:", err);
    }
  });

  // Nouveau message
  socket.on("send-group-message", async (data) => {
    try {
      if (!socket.userId) return;

      const message = new Message({
        sender: socket.userId,
        content: data.content,
        mediaUrl: data.mediaUrl,
        audioUrl: data.audioUrl
      });

      await message.save();
      await message.populate("sender", "firstName lastName profilePhoto");

      io.to("general").emit("new-group-message", message);
    } catch (err) {
      console.error("❌ send message:", err);
    }
  });

  // Edition
  socket.on("edit-message", async ({ messageId, newContent }) => {
    const msg = await Message.findById(messageId);
    if (!msg || msg.sender.toString() !== socket.userId) return;

    msg.content = newContent;
    msg.isEdited = true;
    await msg.save();
    io.to("general").emit("message-updated", msg);
  });

  // Suppression
  socket.on("delete-message", async ({ messageId }) => {
    const msg = await Message.findById(messageId);
    if (!msg || msg.sender.toString() !== socket.userId) return;

    msg.isDeleted = true;
    msg.content = "Message supprimé";
    await msg.save();
    io.to("general").emit("message-deleted", msg);
  });

  // Typing
  socket.on("typing", (data) => {
    if (socket.user) {
      socket.broadcast.to("general").emit("user-typing", {
        userId: socket.userId,
        firstName: socket.user.firstName,
        lastName: socket.user.lastName,
        isTyping: data.isTyping
      });
    }
  });

  // Déconnexion
  socket.on("disconnect", async () => {
    if (socket.userId) {
      await User.findByIdAndUpdate(socket.userId, { isOnline: false, lastSeen: new Date() });
      io.emit("user-offline", { userId: socket.userId });
    }
    console.log("🚪 Déconnecté:", socket.id);
  });
});

// ---------------- ROUTES API ----------------

// Register
app.post("/api/register", async (req, res) => {
  try {
    const { email, password, firstName, lastName } = req.body;
    if (await User.findOne({ email })) return res.status(400).json({ message: "Email déjà utilisé" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword, firstName, lastName });
    await user.save();
    res.json({ message: "Compte créé" });
  } catch {
    res.status(500).json({ message: "Erreur inscription" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.status(400).json({ message: "Utilisateur introuvable" });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ message: "Mot de passe incorrect" });

  const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: "1h" });
  res.json({ token, user });
});

// Profil
app.get("/api/user/profile", authenticateToken, (req, res) => res.json(req.user));

// Upload media (images/docs/videos/audio)
app.post("/api/chat/upload", authenticateToken, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "Aucun fichier" });
  res.json({ url: "/" + req.file.path });
});

// Messages historiques
app.get("/api/chat/messages", authenticateToken, async (req, res) => {
  const messages = await Message.find({ isGroupMessage: true })
    .populate("sender", "firstName lastName profilePhoto")
    .sort({ timestamp: 1 });
  res.json(messages);
});

// ---------------- SERVER ----------------
server.listen(PORT, () => console.log(`🚀 Serveur backend démarré sur http://localhost:${PORT}`));


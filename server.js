require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

// Configuration des variables d'environnement
const PORT = process.env.PORT || 5000;
const MONGO_USER = process.env.MONGO_USER;
const MONGO_PASSWORD = encodeURIComponent(process.env.MONGO_PASSWORD);
const MONGO_CLUSTER = process.env.MONGO_CLUSTER;
const MONGO_DB_NAME = process.env.MONGO_DB_NAME;
const MONGO_URI = `mongodb+srv://${MONGO_USER}:${MONGO_PASSWORD}@${MONGO_CLUSTER}/${MONGO_DB_NAME}?retryWrites=true&w=majority&appName=Cluster0`;
const JWT_SECRET = process.env.JWT_SECRET;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const SUPER_ADMIN_EMAIL = 'nyundumathryme@gmail.com';

// Initialisation de l'application Express
const app = express();
const server = http.createServer(app);

// Configuration Socket.io
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static('uploads'));

// Configuration de Multer pour les uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = 'uploads/';
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath);
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  },
});
const upload = multer({ storage });

// ✅ CORRECTION NODEMAILER
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

// Modèles Mongoose
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'manager', 'employee'], default: 'employee' },
  isVerified: { type: Boolean, default: false },
  isApproved: { type: Boolean, default: true },
  verificationCode: { type: String },
  verificationCodeExpiry: { type: Date },
  firstName: { type: String },
  lastName: { type: String },
  profilePhoto: { type: String },
  nip: { type: String },
  passport: { type: String },
  professionalCard: { type: String },
  certificates: [{
    title: { type: String, required: true },
    creationDate: { type: Date, required: true },
    expiryDate: { type: Date, required: true },
    filePath: { type: String },
    imagePath: { type: String },
  }],
  isOnline: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now }
});

const employeeSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  department: { type: String, required: true },
  position: { type: String, required: true },
  hireDate: { type: Date, required: true },
  profilePhoto: { type: String },
  pdfPath: { type: String },
  customFields: { type: Map, of: mongoose.Schema.Types.Mixed },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

const formSchema = new mongoose.Schema({
  name: { type: String, required: true },
  content: { type: String, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  views: { type: Number, default: 0 },
  viewers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  isGroupMessage: { type: Boolean, default: true }
});

const User = mongoose.model('User', userSchema);
const Employee = mongoose.model('Employee', employeeSchema);
const Form = mongoose.model('Form', formSchema);
const Message = mongoose.model('Message', messageSchema);

// Connexion à MongoDB
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('✅ Connecté à MongoDB');
    await createSuperAdmin();
  })
  .catch(err => console.error('❌ Erreur de connexion à MongoDB:', err));

// Fonction pour activer/forcer le super admin
async function createSuperAdmin() {
  const superEmail = SUPER_ADMIN_EMAIL;
  let superUser = await User.findOne({ email: superEmail });
  const defaultPassword = 'superadminpassword';
  const hashedPassword = await bcrypt.hash(defaultPassword, 10);

  if (!superUser) {
    superUser = new User({
      email: superEmail,
      password: hashedPassword,
      role: 'admin',
      isVerified: true,
      isApproved: true,
      firstName: 'Super',
      lastName: 'Admin',
    });
    await superUser.save();
    console.log('🎯 Super Admin créé avec succès. Mot de passe :', defaultPassword);
  } else {
    superUser.role = 'admin';
    superUser.isVerified = true;
    superUser.isApproved = true;
    superUser.password = hashedPassword;
    await superUser.save();
    console.log('🎯 Super Admin activé avec succès. Mot de passe :', defaultPassword);
  }
}

// Socket.io pour le chat en temps réel
io.on('connection', (socket) => {
  console.log('🎮 Utilisateur connecté:', socket.id);

  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.userId);
      if (user) {
        socket.userId = user._id.toString();
        socket.user = user;
        
        await User.findByIdAndUpdate(user._id, { 
          isOnline: true, 
          lastSeen: new Date() 
        });
        
        socket.join('general');
        
        socket.broadcast.emit('user-online', {
          userId: user._id,
          firstName: user.firstName,
          lastName: user.lastName
        });
        
        console.log(`👤 Utilisateur authentifié: ${user.firstName} ${user.lastName}`);
      }
    } catch (err) {
      console.error('❌ Erreur authentification socket:', err);
    }
  });

  socket.on('send-group-message', async (data) => {
    try {
      if (!socket.userId) return;
      
      const { content } = data;
      
      const message = new Message({
        sender: socket.userId,
        content,
        isGroupMessage: true
      });
      
      await message.save();
      await message.populate('sender', 'firstName lastName profilePhoto');
      
      io.to('general').emit('new-group-message', {
        _id: message._id,
        content: message.content,
        timestamp: message.timestamp,
        sender: {
          _id: message.sender._id,
          firstName: message.sender.firstName,
          lastName: message.sender.lastName,
          profilePhoto: message.sender.profilePhoto
        }
      });
      
    } catch (err) {
      console.error('❌ Erreur envoi message:', err);
    }
  });

  socket.on('typing', (data) => {
    if (socket.user) {
      socket.broadcast.to('general').emit('user-typing', {
        userId: socket.userId,
        firstName: socket.user.firstName,
        lastName: socket.user.lastName,
        isTyping: data.isTyping
      });
    }
  });

  socket.on('disconnect', async () => {
    if (socket.userId) {
      await User.findByIdAndUpdate(socket.userId, { 
        isOnline: false, 
        lastSeen: new Date() 
      });
      
      socket.broadcast.emit('user-offline', {
        userId: socket.userId
      });
    }
    
    console.log('🚪 Utilisateur déconnecté:', socket.id);
  });
});

// Middleware JWT
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token requis' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(decoded.userId);
    if (!req.user) return res.status(401).json({ message: 'Utilisateur non trouvé' });
    next();
  } catch (err) {
    res.status(403).json({ message: 'Token invalide' });
  }
};

// Middleware rôles
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Accès non autorisé' });
    }
    next();
  };
};

// Générer code vérification
const generateVerificationCode = () => {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
};

// Route d'inscription
app.post('/api/register', upload.fields([
  { name: 'profilePhoto', maxCount: 1 },
  { name: 'professionalCard', maxCount: 1 },
  { name: 'certificates' }
]), async (req, res) => {
  try {
    const { email, password, firstName, lastName, role, nip, passport, certificatesData } = req.body;
    const certificatesParsed = JSON.parse(certificatesData || '[]');

    if (role === 'admin' && !req.files.professionalCard) {
      return res.status(400).json({ message: 'La carte professionnelle est obligatoire pour les administrateurs.' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Cet email est déjà utilisé.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const profilePhotoPath = req.files.profilePhoto ? req.files.profilePhoto[0].path : null;
    const professionalCardPath = req.files.professionalCard ? req.files.professionalCard[0].path : null;
    const certificates = certificatesParsed.map((cert, index) => ({
      ...cert,
      filePath: req.files.certificates && req.files.certificates[index] ? req.files.certificates[index].path : null
    }));

    const user = new User({
      email,
      password: hashedPassword,
      role,
      firstName,
      lastName,
      profilePhoto: profilePhotoPath,
      professionalCard: professionalCardPath,
      nip,
      passport,
      certificates,
      isVerified: email === SUPER_ADMIN_EMAIL,
    });

    if (role === 'admin' && email !== SUPER_ADMIN_EMAIL) {
      user.isApproved = false;
    }

    await user.save();

    if (email !== SUPER_ADMIN_EMAIL) {
      user.verificationCode = generateVerificationCode();
      user.verificationCodeExpiry = Date.now() + 24 * 60 * 60 * 1000;
      await user.save();

      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Vérification de votre compte',
        html: `<p>Merci pour votre inscription ! Votre code de vérification est : <strong>${user.verificationCode}</strong></p>
               <p>Ce code expire dans 24 heures.</p>`
      };

      await transporter.sendMail(mailOptions);

      res.status(200).json({ message: 'Inscription réussie ! Un code de vérification à 8 chiffres a été envoyé à votre email.' });
    } else {
      res.status(200).json({ message: 'Inscription réussie pour le super admin ! Vous pouvez vous connecter directement.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur lors de l\'inscription' });
  }
});

// Route pour vérifier le code
app.post('/api/verify-code', async (req, res) => {
  try {
    const { email, code } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ message: 'Utilisateur non trouvé' });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: 'Compte déjà vérifié' });
    }

    if (user.verificationCode !== code) {
      return res.status(400).json({ message: 'Code invalide' });
    }

    if (user.verificationCodeExpiry < Date.now()) {
      return res.status(400).json({ message: 'Code expiré' });
    }

    user.isVerified = true;
    user.verificationCode = undefined;
    user.verificationCodeExpiry = undefined;
    await user.save();

    res.status(200).json({ message: 'Compte vérifié avec succès ! Vous pouvez maintenant vous connecter.' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la vérification' });
  }
});

// Route de connexion
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ message: 'Utilisateur non trouvé' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Mot de passe incorrect' });
    }

    if (!user.isVerified) {
      return res.status(403).json({ message: 'Compte non vérifié. Vérifiez votre email pour le code.', needsVerification: true });
    }

    if (user.role === 'admin' && !user.isApproved) {
      return res.status(403).json({ message: 'Compte en attente d\'approbation par un administrateur.', needsApproval: true });
    }

    const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, role: user.role });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la connexion' });
  }
});

// Profil utilisateur
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Mise à jour photo de profil
app.post('/api/user/update-profile-photo', authenticateToken, upload.single('profilePhoto'), async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (req.file) {
      user.profilePhoto = req.file.path;
      await user.save();
      res.json({ message: 'Photo mise à jour', profilePhoto: user.profilePhoto });
    } else {
      res.status(400).json({ message: 'Aucun fichier fourni' });
    }
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la mise à jour' });
  }
});

// Mise à jour profil
app.post('/api/user/update-profile', authenticateToken, async (req, res) => {
  try {
    const { firstName, lastName } = req.body;
    const user = await User.findById(req.user._id);
    user.firstName = firstName;
    user.lastName = lastName;
    await user.save();
    res.json({ firstName: user.firstName, lastName: user.lastName });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la mise à jour' });
  }
});

// Ajouter certificat
app.post('/api/user/add-certificate', authenticateToken, upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'image', maxCount: 1 }
]), async (req, res) => {
  try {
    const { title, creationDate, expiryDate } = req.body;
    const user = await User.findById(req.user._id);
    const newCert = {
      title,
      creationDate,
      expiryDate,
      filePath: req.files['file'] ? req.files['file'][0].path : null,
      imagePath: req.files['image'] ? req.files['image'][0].path : null,
    };
    user.certificates.push(newCert);
    await user.save();
    res.json({ certificates: user.certificates });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de l\'ajout du certificat' });
  }
});

// Modifier certificat
app.post('/api/user/edit-certificate', authenticateToken, upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'image', maxCount: 1 }
]), async (req, res) => {
  try {
    const { index, title, creationDate, expiryDate } = req.body;
    const user = await User.findById(req.user._id);
    const cert = user.certificates[index];
    if (!cert) return res.status(404).json({ message: 'Certificat non trouvé' });
    cert.title = title;
    cert.creationDate = creationDate;
    cert.expiryDate = expiryDate;
    if (req.files['file']) cert.filePath = req.files['file'][0].path;
    if (req.files['image']) cert.imagePath = req.files['image'][0].path;
    await user.save();
    res.json({ certificates: user.certificates });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la modification du certificat' });
  }
});

// Supprimer certificat
app.post('/api/user/delete-certificate', authenticateToken, async (req, res) => {
  try {
    const { index } = req.body;
    const user = await User.findById(req.user._id);
    if (index < 0 || index >= user.certificates.length) {
      return res.status(404).json({ message: 'Certificat non trouvé' });
    }
    user.certificates.splice(index, 1);
    await user.save();
    res.json({ certificates: user.certificates });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la suppression du certificat' });
  }
});

// Statistiques
app.get('/api/stats', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  try {
    const totalEmployees = await Employee.countDocuments();
    const expiredCertificates = await User.aggregate([
      { $unwind: '$certificates' },
      { $match: { 'certificates.expiryDate': { $lt: new Date() } } },
      { $count: 'expired' }
    ]);
    const totalCertificates = await User.aggregate([
      { $unwind: '$certificates' },
      { $count: 'total' }
    ]);
    const expiringSoonCertificates = await User.aggregate([
      { $unwind: '$certificates' },
      { $match: { 'certificates.expiryDate': { $gt: new Date(), $lt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } } },
      { $count: 'expiringSoon' }
    ]);

    let userStats = {};
    if (req.user.role === 'admin') {
      userStats = {
        totalUsers: await User.countDocuments(),
        verifiedUsers: await User.countDocuments({ isVerified: true }),
        approvedUsers: await User.countDocuments({ isApproved: true }),
      };
    }

    res.json({ 
      totalEmployees, 
      expiredCertificates: expiredCertificates[0]?.expired || 0,
      totalCertificates: totalCertificates[0]?.total || 0,
      expiringSoonCertificates: expiringSoonCertificates[0]?.expiringSoon || 0,
      ...userStats
    });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Liste employés
app.get('/api/employees', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  try {
    const employees = await Employee.find();
    res.json(employees);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Ajouter employé
app.post('/api/employees', authenticateToken, restrictTo('admin', 'manager'), upload.fields([{ name: 'profilePhoto', maxCount: 1 }, { name: 'pdf', maxCount: 1 }]), async (req, res) => {
  try {
    const { firstName, lastName, email, department, position, hireDate } = req.body;
    const profilePhoto = req.files['profilePhoto'] ? req.files['profilePhoto'][0].path : null;
    const pdfPath = req.files['pdf'] ? req.files['pdf'][0].path : null;
    const employee = new Employee({ firstName, lastName, email, department, position, hireDate, profilePhoto, pdfPath, createdBy: req.user._id });
    await employee.save();
    res.json(employee);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de l\'ajout de l\'employé' });
  }
});

// Mettre à jour employé
app.put('/api/employees/:id', authenticateToken, restrictTo('admin', 'manager'), upload.fields([{ name: 'profilePhoto', maxCount: 1 }, { name: 'pdf', maxCount: 1 }]), async (req, res) => {
  try {
    const { firstName, lastName, email, department, position, hireDate } = req.body;
    const employee = await Employee.findById(req.params.id);
    if (!employee) return res.status(404).json({ message: 'Employé non trouvé' });

    employee.firstName = firstName || employee.firstName;
    employee.lastName = lastName || employee.lastName;
    employee.email = email || employee.email;
    employee.department = department || employee.department;
    employee.position = position || employee.position;
    employee.hireDate = hireDate || employee.hireDate;

    if (req.files['profilePhoto']) employee.profilePhoto = req.files['profilePhoto'][0].path;
    if (req.files['pdf']) employee.pdfPath = req.files['pdf'][0].path;

    await employee.save();
    res.json(employee);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la mise à jour de l\'employé' });
  }
});

// Supprimer employé
app.delete('/api/employees/:id', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  try {
    const employee = await Employee.findByIdAndDelete(req.params.id);
    if (!employee) return res.status(404).json({ message: 'Employé non trouvé' });
    res.json({ message: 'Employé supprimé' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la suppression de l\'employé' });
  }
});

// Liste formulaires
app.get('/api/forms', authenticateToken, async (req, res) => {
  try {
    const forms = await Form.find();
    res.json(forms);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Récupérer article par ID
app.get('/api/forms/:id', authenticateToken, async (req, res) => {
  try {
    const article = await Form.findById(req.params.id);
    if (!article) {
      return res.status(404).json({ message: 'Article non trouvé' });
    }
    res.json(article);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Ajouter formulaire
app.post('/api/forms', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  try {
    const { name, content } = req.body;
    const form = new Form({ name, content, createdBy: req.user._id });
    await form.save();

    const users = await User.find({}, 'email');
    const emails = users.map(u => u.email);

    const stripHtml = (html) => html.replace(/<[^>]*>/g, '');
    const excerpt = stripHtml(content).substring(0, 200) + '...';

    let photoPath = null;
    const imgMatch = content.match(/<img\s+src="([^"]+)"/i);
    if (imgMatch && imgMatch[1]) {
      photoPath = imgMatch[1].replace(/^\//, '');
      if (!fs.existsSync(photoPath)) photoPath = null;
    }

    const logoPath = 'uploads/logo.png';

    const attachments = [];
    if (fs.existsSync(logoPath)) {
      attachments.push({
        filename: 'logo.png',
        path: logoPath,
        cid: 'logo'
      });
    }
    if (photoPath && fs.existsSync(photoPath)) {
      attachments.push({
        filename: 'article_photo.jpg',
        path: photoPath,
        cid: 'articlePhoto'
      });
    }

    let emailHtml = `
      <div style="text-align: center;">
        <img src="cid:logo" alt="Logo de l'application" style="max-width: 200px;" />
      </div>
      <h1>${name}</h1>
      <p>${excerpt}</p>
    `;
    if (photoPath) {
      emailHtml += `
        <img src="cid:articlePhoto" alt="Photo de l'article" style="max-width: 100%;" />
        <p style="text-align: center; font-style: italic;">Légende : Photo illustrative de l'article</p>
      `;
    }
    emailHtml += `<p>Connectez-vous pour lire la suite.</p>`;

    emails.forEach(email => {
      const mailOptions = {
        from: EMAIL_USER,
        to: email,
        subject: `Nouvel article publié : ${name}`,
        html: emailHtml,
        attachments: attachments
      };
      transporter.sendMail(mailOptions, (err, info) => {
        if (err) console.error(`Erreur lors de l'envoi de l'email à ${email}:`, err);
        else console.log(`Email envoyé à ${email}:`, info.response);
      });
    });

    res.json(form);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de l\'ajout du formulaire' });
  }
});

// Mettre à jour formulaire
app.put('/api/forms/:id', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  try {
    const { name, content } = req.body;
    const form = await Form.findById(req.params.id);
    if (!form) return res.status(404).json({ message: 'Formulaire non trouvé' });
    if (form.createdBy.toString() !== req.user._id.toString()) return res.status(403).json({ message: 'Non autorisé' });
    form.name = name || form.name;
    form.content = content || form.content;
    await form.save();
    res.json(form);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la mise à jour du formulaire' });
  }
});

// Supprimer formulaire
app.delete('/api/forms/:id', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  try {
    const form = await Form.findById(req.params.id);
    if (!form) return res.status(404).json({ message: 'Formulaire non trouvé' });
    if (form.createdBy.toString() !== req.user._id.toString()) return res.status(403).json({ message: 'Non autorisé' });
    await Form.deleteOne({ _id: req.params.id });
    res.json({ message: 'Formulaire supprimé' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la suppression du formulaire' });
  }
});

// Incrementer vues article
app.post('/api/forms/:id/view', authenticateToken, async (req, res) => {
  try {
    const form = await Form.findById(req.params.id);
    if (!form) return res.status(404).json({ message: 'Formulaire non trouvé' });
    if (!form.viewers.includes(req.user._id)) {
      form.viewers.push(req.user._id);
      form.views += 1;
      await form.save();
    }
    res.json({ views: form.views });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de l\'incrémentation des vues' });
  }
});

// Viewers d'un article
app.get('/api/forms/:id/viewers', authenticateToken, async (req, res) => {
  try {
    const form = await Form.findById(req.params.id).populate('viewers', 'firstName lastName profilePhoto');
    if (!form) return res.status(404).json({ message: 'Formulaire non trouvé' });
    res.json(form.viewers);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la récupération des viewers' });
  }
});

// Upload média
app.post('/api/upload-media', authenticateToken, restrictTo('admin', 'manager'), upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Aucun fichier fourni' });
    }
    const mediaUrl = `/${req.file.path}`;
    res.json({ url: mediaUrl });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de l\'upload du média' });
  }
});

// ✅ ENDPOINTS CHAT
app.get('/api/users/chat', authenticateToken, async (req, res) => {
  try {
    const users = await User.find({
      isVerified: true,
      isApproved: true
    }).select('firstName lastName profilePhoto role isOnline lastSeen');
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

app.get('/api/chat/messages', authenticateToken, async (req, res) => {
  try {
    const messages = await Message.find({ isGroupMessage: true })
      .populate('sender', 'firstName lastName profilePhoto')
      .sort({ timestamp: -1 })
      .limit(50);
    
    res.json(messages.reverse());
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Liste utilisateurs (admin)
app.get('/api/users', authenticateToken, restrictTo('admin'), async (req, res) => {
  try {
    const users = await User.find().select('-password -verificationCode -verificationCodeExpiry');
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Approuver utilisateur
app.post('/api/users/:id/approve', authenticateToken, restrictTo('admin'), async (req, res) => {
  try {
    const userToApprove = await User.findById(req.params.id);
    if (!userToApprove) return res.status(404).json({ message: 'Utilisateur non trouvé' });
    userToApprove.isApproved = true;
    await userToApprove.save();
    res.json({ message: 'Utilisateur approuvé' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de l\'approbation' });
  }
});

// Rejeter utilisateur
app.post('/api/users/:id/reject', authenticateToken, restrictTo('admin'), async (req, res) => {
  try {
    const userToReject = await User.findById(req.params.id);
    if (!userToReject) return res.status(404).json({ message: 'Utilisateur non trouvé' });
    userToReject.isApproved = false;
    await userToReject.save();
    res.json({ message: 'Utilisateur rejeté' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors du rejet' });
  }
});

// Mettre à jour rôle
app.post('/api/users/:id/update-role', authenticateToken, restrictTo('admin'), async (req, res) => {
  try {
    const { role } = req.body;
    const userToUpdate = await User.findById(req.params.id);
    if (!userToUpdate) return res.status(404).json({ message: 'Utilisateur non trouvé' });
    if (!['admin', 'manager', 'employee'].includes(role)) return res.status(400).json({ message: 'Rôle invalide' });
    userToUpdate.role = role;
    if (role === 'admin') {
      userToUpdate.isApproved = true;
    } else {
      userToUpdate.isApproved = true;
    }
    await userToUpdate.save();
    res.json({ message: 'Rôle mis à jour', role: userToUpdate.role });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la mise à jour du rôle' });
  }
});

// Utilisateurs avec positions
app.get('/api/users/with-positions', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  try {
    const users = await User.find({
      role: { $in: ['employee', 'admin'] },
      isVerified: true,
      isApproved: true
    }).select('-password -verificationCode -verificationCodeExpiry');
    
    const usersWithPositions = users.map(user => ({
      ...user.toObject(),
      position: {
        lat: 48.8566 + (Math.random() - 0.5) * 0.1,
        lng: 2.3522 + (Math.random() - 0.5) * 0.1,
        lastUpdate: new Date()
      }
    }));
    
    res.json(usersWithPositions);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Gestion erreurs globales
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Erreur serveur', error: err.message });
});

// Démarrage serveur
server.listen(PORT, () => {
  console.log(`🚀 Serveur + Socket.io démarré sur le port ${PORT}`);
});


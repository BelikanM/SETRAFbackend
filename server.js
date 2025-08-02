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
const SUPER_ADMIN_EMAIL = 'nyundumathryme@gmail.com'; // Email du super admin permanent

// Initialisation de l'application Express
const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads')); // Servir les fichiers statiques pour photos et certificats

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

// Connexion à MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('Connecté à MongoDB'))
  .catch(err => console.error('Erreur de connexion à MongoDB:', err));

// Configuration de Nodemailer
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
  verificationCode: { type: String },
  verificationCodeExpiry: { type: Date },
  firstName: { type: String },
  lastName: { type: String },
  profilePhoto: { type: String },
  nip: { type: String },
  passport: { type: String },
  professionalCard: { type: String }, // Carte professionnelle pour admin
  certificates: [{
    title: { type: String, required: true },
    creationDate: { type: Date, required: true },
    expiryDate: { type: Date, required: true },
    filePath: { type: String },
  }],
});

const employeeSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  department: { type: String, required: true },
  position: { type: String, required: true },
  hireDate: { type: Date, required: true },
  customFields: { type: Map, of: mongoose.Schema.Types.Mixed },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

const formSchema = new mongoose.Schema({
  name: { type: String, required: true },
  fields: [
    {
      fieldName: { type: String, required: true },
      fieldType: { type: String, required: true, enum: ['text', 'number', 'date', 'select'] },
      options: [{ type: String }],
      required: { type: Boolean, default: false },
    },
  ],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

const User = mongoose.model('User', userSchema);
const Employee = mongoose.model('Employee', employeeSchema);
const Form = mongoose.model('Form', formSchema);

// Middleware pour vérifier le JWT
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

// Middleware pour vérifier les rôles
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Accès non autorisé' });
    }
    next();
  };
};

// Fonction pour générer un code à 8 chiffres
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
    const certificatesParsed = JSON.parse(certificatesData);

    // Vérifier la carte professionnelle pour admin
    if (role === 'admin' && !req.files.professionalCard) {
      return res.status(400).json({ message: 'La carte professionnelle est obligatoire pour les administrateurs.' });
    }

    // Vérifier si l'email existe déjà
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Cet email est déjà utilisé.' });
    }

    // Hacher le mot de passe
    const hashedPassword = await bcrypt.hash(password, 10);

    // Gérer les fichiers
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
      isVerified: email === SUPER_ADMIN_EMAIL, // Super admin isVerified = true
    });

    await user.save();

    if (email !== SUPER_ADMIN_EMAIL) {
      // Générer le code de vérification à 8 chiffres
      user.verificationCode = generateVerificationCode();
      user.verificationCodeExpiry = Date.now() + 24 * 60 * 60 * 1000; // 24 heures
      await user.save();

      // Envoyer l'email avec le code via Nodemailer
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

// Route pour vérifier le code à 8 chiffres
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

    const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, role: user.role });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la connexion' });
  }
});

// Endpoint pour profil utilisateur
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Endpoint pour mise à jour de la photo de profil
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

// Endpoint pour mise à jour du profil (nom/prénom)
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

// Endpoint pour ajouter un certificat
app.post('/api/user/add-certificate', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const { title, creationDate, expiryDate } = req.body;
    const user = await User.findById(req.user._id);
    const newCert = {
      title,
      creationDate,
      expiryDate,
      filePath: req.file ? req.file.path : null,
    };
    user.certificates.push(newCert);
    await user.save();
    res.json({ certificates: user.certificates });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de l\'ajout du certificat' });
  }
});

// Endpoint pour modifier un certificat
app.post('/api/user/edit-certificate', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    const { index, title, creationDate, expiryDate } = req.body;
    const user = await User.findById(req.user._id);
    const cert = user.certificates[index];
    if (!cert) return res.status(404).json({ message: 'Certificat non trouvé' });
    cert.title = title;
    cert.creationDate = creationDate;
    cert.expiryDate = expiryDate;
    if (req.file) cert.filePath = req.file.path;
    await user.save();
    res.json({ certificates: user.certificates });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la modification du certificat' });
  }
});

// Endpoint pour statistiques (pour dashboard)
app.get('/api/stats', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  try {
    const totalEmployees = await Employee.countDocuments();
    const expiredCertificates = await User.aggregate([
      { $unwind: '$certificates' },
      { $match: { 'certificates.expiryDate': { $lt: new Date() } } },
      { $count: 'expired' }
    ]);
    res.json({ totalEmployees, expiredCertificates: expiredCertificates[0]?.expired || 0 });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Endpoint pour liste des employés
app.get('/api/employees', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  try {
    const employees = await Employee.find();
    res.json(employees);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Endpoint pour ajouter un employé (exemple, à adapter si besoin)
app.post('/api/employees', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  try {
    const employee = new Employee({ ...req.body, createdBy: req.user._id });
    await employee.save();
    res.json(employee);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de l\'ajout de l\'employé' });
  }
});

// Endpoint pour liste des formulaires (exemple, à implémenter fully si besoin)
app.get('/api/forms', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  try {
    const forms = await Form.find({ createdBy: req.user._id });
    res.json(forms);
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

// Endpoint pour ajouter un formulaire (exemple)
app.post('/api/forms', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  try {
    const form = new Form({ ...req.body, createdBy: req.user._id });
    await form.save();
    res.json(form);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de l\'ajout du formulaire' });
  }
});

// Gestion des erreurs globales
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Erreur serveur', error: err.message });
});

// Démarrage du serveur
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});

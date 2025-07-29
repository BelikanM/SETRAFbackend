// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const cors = require('cors');

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

// Initialisation de l'application Express
const app = express();
app.use(cors());
app.use(express.json());

// Connexion à MongoDB
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
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
      options: [{ type: String }], // Pour les champs de type "select"
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

// Routes d'authentification
app.post('/api/register', async (req, res) => {
  const { email, password, role } = req.body;
  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: 'Email déjà utilisé' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword, role });
    await user.save();

    const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    res.status(201).json({ token, user: { email, role } });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de l\'inscription', error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Utilisateur non trouvé' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Mot de passe incorrect' });

    const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, user: { email, role: user.role } });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la connexion', error: err.message });
  }
});

// Routes pour les employés
app.post('/api/employees', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  const { firstName, lastName, email, department, position, hireDate, customFields } = req.body;
  try {
    const employee = new Employee({
      firstName,
      lastName,
      email,
      department,
      position,
      hireDate,
      customFields,
      createdBy: req.user._id,
    });
    await employee.save();

    // Envoi d'email de notification
    const mailOptions = {
      from: EMAIL_USER,
      to: email,
      subject: 'Bienvenue dans l\'équipe !',
      text: `Bonjour ${firstName}, vous avez été ajouté en tant que ${position} dans le département ${department}.`,
    };
    await transporter.sendMail(mailOptions);

    res.status(201).json(employee);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de l\'ajout de l\'employé', error: err.message });
  }
});

app.get('/api/employees', authenticateToken, async (req, res) => {
  try {
    const employees = await Employee.find().populate('createdBy', 'email');
    res.json(employees);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la récupération des employés', error: err.message });
  }
});

app.get('/api/employees/:id', authenticateToken, async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id).populate('createdBy', 'email');
    if (!employee) return res.status(404).json({ message: 'Employé non trouvé' });
    res.json(employee);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la récupération de l\'employé', error: err.message });
  }
});

app.put('/api/employees/:id', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  const { firstName, lastName, email, department, position, hireDate, customFields } = req.body;
  try {
    const employee = await Employee.findByIdAndUpdate(
      req.params.id,
      { firstName, lastName, email, department, position, hireDate, customFields },
      { new: true }
    );
    if (!employee) return res.status(404).json({ message: 'Employé non trouvé' });
    res.json(employee);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la mise à jour de l\'employé', error: err.message });
  }
});

app.delete('/api/employees/:id', authenticateToken, restrictTo('admin'), async (req, res) => {
  try {
    const employee = await Employee.findByIdAndDelete(req.params.id);
    if (!employee) return res.status(404).json({ message: 'Employé non trouvé' });
    res.json({ message: 'Employé supprimé avec succès' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la suppression de l\'employé', error: err.message });
  }
});

// Routes pour les formulaires dynamiques
app.post('/api/forms', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  const { name, fields } = req.body;
  try {
    const form = new Form({ name, fields, createdBy: req.user._id });
    await form.save();
    res.status(201).json(form);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la création du formulaire', error: err.message });
  }
});

app.get('/api/forms', authenticateToken, async (req, res) => {
  try {
    const forms = await Form.find().populate('createdBy', 'email');
    res.json(forms);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la récupération des formulaires', error: err.message });
  }
});

app.get('/api/forms/:id', authenticateToken, async (req, res) => {
  try {
    const form = await Form.findById(req.params.id).populate('createdBy', 'email');
    if (!form) return res.status(404).json({ message: 'Formulaire non trouvé' });
    res.json(form);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la récupération du formulaire', error: err.message });
  }
});

app.put('/api/forms/:id', authenticateToken, restrictTo('admin', 'manager'), async (req, res) => {
  const { name, fields } = req.body;
  try {
    const form = await Form.findByIdAndUpdate(req.params.id, { name, fields }, { new: true });
    if (!form) return res.status(404).json({ message: 'Formulaire non trouvé' });
    res.json(form);
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la mise à jour du formulaire', error: err.message });
  }
});

app.delete('/api/forms/:id', authenticateToken, restrictTo('admin'), async (req, res) => {
  try {
    const form = await Form.findByIdAndDelete(req.params.id);
    if (!form) return res.status(404).json({ message: 'Formulaire non trouvé' });
    res.json({ message: 'Formulaire supprimé avec succès' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur lors de la suppression du formulaire', error: err.message });
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

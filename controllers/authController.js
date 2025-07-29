const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sendEmail = require('../utils/sendEmail');

const JWT_SECRET = process.env.JWT_SECRET;

// ✅ Inscription
exports.register = async (req, res) => {
  const { email, password } = req.body;

  try {
    const existingUser = await User.findOne({ email });
    if (existingUser)
      return res.status(400).json({ message: 'Utilisateur déjà inscrit.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationCode = Math.floor(100000 + Math.random() * 900000);

    const user = new User({
      email,
      password: hashedPassword,
      verificationCode,
    });

    await user.save();

    // ✅ Envoi du code par mail
    await sendEmail(email, 'Code de vérification', `Votre code est : ${verificationCode}`);

    res.status(201).json({ message: 'Utilisateur inscrit. Vérifiez votre email.' });
  } catch (err) {
    console.error('Erreur inscription :', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ✅ Vérification du code
exports.verify = async (req, res) => {
  const { email, code } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable.' });

    if (user.verificationCode != code)
      return res.status(400).json({ message: 'Code incorrect.' });

    user.verified = true;
    user.verificationCode = null;
    await user.save();

    res.status(200).json({ message: 'Vérification réussie. Vous pouvez vous connecter.' });
  } catch (err) {
    console.error('Erreur vérification :', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// ✅ Connexion
exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Mot de passe incorrect.' });

    if (!user.verified)
      return res.status(403).json({ message: 'Veuillez vérifier votre email d’abord.' });

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '2h' });

    res.status(200).json({ message: 'Connexion réussie', token });
  } catch (err) {
    console.error('Erreur connexion :', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

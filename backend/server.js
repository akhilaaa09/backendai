import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import mongoose from "mongoose";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: "*" }));

const JWT_SECRET = process.env.JWT_SECRET || "ats_resume_pro_secret_key_2024";

// ── MongoDB Connection ───────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// ── User Schema ──────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true },
  name:      { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);

// ── Analysis Schema ──────────────────────────────────────────────────────────
const analysisSchema = new mongoose.Schema({
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  filename:        { type: String, default: "resume.pdf" },
  jobDescription:  { type: String },
  ats_score:       { type: Number },
  job_match_score: { type: Number },
  summary_verdict: { type: String },
  matched_keywords:{ type: [String], default: [] },
  missing_keywords:{ type: [String], default: [] },
  improvements:    { type: [String], default: [] },
  resume:          { type: mongoose.Schema.Types.Mixed },
  createdAt:       { type: Date, default: Date.now },
});

const Analysis = mongoose.model("Analysis", analysisSchema);

// ── Multer ───────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ── OpenAI / Groq client ─────────────────────────────────────────────────────
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// ── Auth Middleware ──────────────────────────────────────────────────────────
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "Unauthorized. Please log in." });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: "Invalid or expired token. Please log in again." });
  }
};

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.send("🚀 ATS Resume Pro Backend Running"));

// ── REGISTER ─────────────────────────────────────────────────────────────────
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password)
      return res.status(400).json({ success: false, error: "Email and password are required." });

    if (password.length < 6)
      return res.status(400).json({ success: false, error: "Password must be at least 6 characters." });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email))
      return res.status(400).json({ success: false, error: "Please enter a valid email address." });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(409).json({ success: false, error: "An account with this email already exists." });

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = new User({ email: email.toLowerCase(), password: hashedPassword, name: name || "" });
    await user.save();

    const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });

    return res.status(201).json({
      success: true,
      message: "Account created successfully.",
      token,
      user: { id: user._id, email: user.email, name: user.name },
    });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ success: false, error: err.message || "Registration failed." });
  }
});

// ── LOGIN ────────────────────────────────────────────────────────────────────
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ success: false, error: "Email and password are required." });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user)
      return res.status(401).json({ success: false, error: "Invalid email or password." });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(401).json({ success: false, error: "Invalid email or password." });

    const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      success: true,
      message: "Login successful.",
      token,
      user: { id: user._id, email: user.email, name: user.name },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ success: false, error: err.message || "Login failed." });
  }
});

// ── GET /auth/me — verify token & get user ───────────────────────────────────
app.get("/auth/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password");
    if (!user) return res.status(404).json({ success: false, error: "User not found." });
    res.json({ success: true, user: { id: user._id, email: user.email, name: user.name } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── /analyze — protected ─────────────────────────────────────────────────────
app.post("/analyze", authMiddleware, upload.single("resume"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, error: "Please upload a resume PDF." });

    const jobText = req.body.jd?.trim() || "Software Developer";

    // Extract PDF text
    const pdfDoc = await pdfjsLib
      .getDocument({ data: new Uint8Array(req.file.buffer) })
      .promise;

    let resumeText = "";
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page    = await pdfDoc.getPage(i);
      const content = await page.getTextContent();
      resumeText   += content.items.map((item) => item.str).join(" ") + "\n";
    }

    const cleanText = resumeText
      .replace(/\s+/g, " ")
      .replace(/[^\x20-\x7E\n]/g, "")
      .trim();

    if (!cleanText || cleanText.length < 50) {
      return res.status(400).json({
        success: false,
        error: "Could not extract text from PDF. Please use a text-based PDF.",
      });
    }

    // ── Prompt ────────────────────────────────────────────────────────────────
    const prompt = `You are an elite ATS resume analyst and professional resume writer with 15+ years of experience at top tech companies.
Analyze the resume against the job description and return ONLY a valid JSON object — no markdown, no code fences, no text before or after.

JSON Structure:
{
  "ats_score": <0-100>,
  "job_match_score": <0-100>,
  "summary_verdict": "<one-sentence overall assessment>",
  "matched_keywords": ["kw1", "kw2", ...],
  "missing_keywords": ["kw1", "kw2", ...],
  "improvements": ["specific improvement 1", "specific improvement 2", ...],
  "resume": {
    "name": "Full Name from resume",
    "phone": "phone number",
    "email": "email address",
    "linkedin": "linkedin URL or username",
    "github": "github URL or username",
    "location": "City, State/Country",
    "objective": "3-4 sentence professional summary tailored to the JD with strong action verbs and JD keywords",
    "education": [
      {
        "degree": "B.Tech Computer Science and Engineering",
        "institution": "Full University Name",
        "location": "City, State",
        "year": "2020 – 2024",
        "score": "8.5 CGPA / 85%",
        "relevant_courses": ["Data Structures", "Algorithms", "DBMS"]
      }
    ],
    "experience": [
      {
        "title": "Job Title",
        "company": "Company Name",
        "location": "City, State / Remote",
        "duration": "Jun 2023 – Aug 2023",
        "type": "Internship",
        "points": [
          "Led development of X feature using Y technology, reducing Z metric by N%"
        ]
      }
    ],
    "skills": {
      "languages":  [{ "name": "Python", "added": false }],
      "frameworks": [{ "name": "React", "added": false }],
      "databases":  [{ "name": "MySQL", "added": false }],
      "tools":      [{ "name": "Git", "added": false }],
      "cloud":      [{ "name": "AWS", "added": true }],
      "concepts":   [{ "name": "REST APIs", "added": false }],
      "other":      []
    },
    "projects": [
      {
        "title": "Project Name",
        "tech": "React, Node.js, MongoDB",
        "github": "github.com/user/project",
        "live": "project-demo.vercel.app",
        "points": ["Built full-stack application..."]
      }
    ],
    "achievements": ["Ranked in top 5% among 50,000+ participants..."],
    "certifications": ["AWS Certified Cloud Practitioner — Amazon Web Services (2023)"],
    "activities": ["Technical Lead, College Coding Club — organized workshops for 300+ students"]
  }
}

CRITICAL RULES:
1. Return ONLY valid JSON.
2. Use ONLY real information from the resume. DO NOT fabricate experience, companies, or dates.
3. For skills: if a skill appears in JD but NOT in resume, add with "added": true.
4. Rewrite ALL project bullets with strong action verbs and quantified impact.
5. Include ALL education levels found (graduation, 12th, 10th, diploma etc).
6. ats_score = formatting quality + keyword richness of ORIGINAL resume (0-100).
7. job_match_score = how well ORIGINAL resume matches JD (0-100).
8. improvements: list 5-8 specific, actionable improvements.
9. If linkedin/github/phone/email not found, use "".

Resume Text:
${cleanText}

Job Description:
${jobText}`;

    const response = await openai.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
      max_tokens: 4000,
      messages: [
        {
          role: "system",
          content: "You are a strict ATS evaluator and expert resume writer. Always respond with valid JSON ONLY. No markdown. No explanation.",
        },
        { role: "user", content: prompt },
      ],
    });

    let raw = response.choices[0].message.content.trim();

    let parsed;
    const attempts = [
      raw,
      raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim(),
      raw.replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim(),
      raw.match(/\{[\s\S]*\}/)?.[0],
    ];

    for (const attempt of attempts) {
      if (!attempt) continue;
      try { parsed = JSON.parse(attempt); break; } catch {}
    }

    if (!parsed) {
      return res.status(500).json({
        success: false,
        error: "AI returned invalid JSON. Please try again.",
        raw: raw.slice(0, 500),
      });
    }

    const doc = new Analysis({
      userId:           req.userId,
      filename:         req.file.originalname,
      jobDescription:   jobText,
      ats_score:        parsed.ats_score,
      job_match_score:  parsed.job_match_score,
      summary_verdict:  parsed.summary_verdict,
      matched_keywords: parsed.matched_keywords || [],
      missing_keywords: parsed.missing_keywords || [],
      improvements:     parsed.improvements || [],
      resume:           parsed.resume,
    });
    await doc.save();

    return res.json({ success: true, result: parsed, savedId: doc._id });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ success: false, error: err.message || "Internal server error." });
  }
});

// ── GET /history — last 20 analyses for this user ────────────────────────────
app.get("/history", authMiddleware, async (req, res) => {
  try {
    const analyses = await Analysis.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("-resume");
    res.json({ success: true, analyses });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /history/:id ─────────────────────────────────────────────────────────
app.get("/history/:id", authMiddleware, async (req, res) => {
  try {
    const doc = await Analysis.findOne({ _id: req.params.id, userId: req.userId });
    if (!doc) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, result: doc });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /history/:id ──────────────────────────────────────────────────────
app.delete("/history/:id", authMiddleware, async (req, res) => {
  try {
    await Analysis.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

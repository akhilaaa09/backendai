import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import mongoose from "mongoose";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: "*" }));

// ── MongoDB Connection ───────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// ── Analysis Schema ──────────────────────────────────────────────────────────
const analysisSchema = new mongoose.Schema({
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

app.get("/", (_, res) => res.send("🚀 ATS Resume Pro Backend Running"));

// ── /analyze ─────────────────────────────────────────────────────────────────
app.post("/analyze", upload.single("resume"), async (req, res) => {
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
      },
      {
        "degree": "Higher Secondary Certificate (12th Grade)",
        "institution": "College Name",
        "location": "City, State",
        "year": "2018 – 2020",
        "score": "95% / 475/500"
      },
      {
        "degree": "Secondary School Certificate (10th Grade)",
        "institution": "School Name",
        "location": "City, State",
        "year": "2018",
        "score": "9.8 CGPA / 98%"
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
          "Led development of X feature using Y technology, reducing Z metric by N%",
          "Built and deployed REST APIs serving 10k+ daily requests",
          "Collaborated with 5-member team using Agile/Scrum methodology"
        ]
      }
    ],
    "skills": {
      "languages":  [{ "name": "Python", "added": false }, { "name": "SQL", "added": true }],
      "frameworks": [{ "name": "React", "added": false }, { "name": "Node.js", "added": false }],
      "databases":  [{ "name": "MySQL", "added": false }, { "name": "MongoDB", "added": true }],
      "tools":      [{ "name": "Git", "added": false }, { "name": "Docker", "added": true }],
      "cloud":      [{ "name": "AWS", "added": true }],
      "concepts":   [{ "name": "REST APIs", "added": false }, { "name": "Agile", "added": false }],
      "other":      []
    },
    "projects": [
      {
        "title": "Project Name",
        "tech": "React, Node.js, MongoDB, AWS",
        "github": "github.com/user/project",
        "live": "project-demo.vercel.app",
        "points": [
          "Built full-stack application with React frontend and Node.js/Express backend serving 500+ users",
          "Designed normalized MongoDB schema reducing query time by 40%",
          "Deployed on AWS EC2 with CI/CD pipeline using GitHub Actions"
        ]
      }
    ],
    "achievements": [
      "Ranked in top 5% among 50,000+ participants in XYZ Coding Challenge (2023)",
      "Secured 2nd place in ABC Hackathon out of 200 teams — built X in 24 hours"
    ],
    "certifications": [
      "AWS Certified Cloud Practitioner — Amazon Web Services (2023)",
      "Full Stack Web Development — Coursera / Meta (2022)"
    ],
    "activities": [
      "Technical Lead, College Coding Club — organized workshops for 300+ students",
      "Open Source Contributor — 15+ PRs merged in popular GitHub repositories"
    ]
  }
}

CRITICAL RULES:
1. Return ONLY valid JSON — absolutely nothing else before or after.
2. Use ONLY real information from the resume. DO NOT fabricate experience, companies, or dates.
3. If experience section has no entries, return "experience": [].
4. For skills: if a skill appears in the JD but NOT in the resume, add it with "added": true. Skills from the resume use "added": false.
5. Rewrite ALL project bullets with strong action verbs and quantified impact where possible (add estimated metrics if none exist).
6. Education: include ALL levels found in the resume (graduation, 12th, 10th, diploma etc). Include relevant_courses only for the highest degree.
7. The objective must be 3-4 strong sentences tailored to JD keywords. Start with a title like "Results-driven Software Engineer..."
8. improvements: list 5-8 specific, actionable improvements (not generic — reference actual resume content).
9. ats_score = formatting quality + keyword richness of the ORIGINAL resume (0-100).
10. job_match_score = how well the ORIGINAL resume matches the JD keywords and requirements (0-100).
11. Keep project tech stacks accurate — only include technologies actually mentioned in resume or project description.
12. If linkedin/github/phone/email not found in resume, use empty string "".

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
          content:
            "You are a strict ATS evaluator and expert resume writer. Always respond with valid JSON ONLY. No markdown. No explanation. No text before or after the JSON object.",
        },
        { role: "user", content: prompt },
      ],
    });

    let raw = response.choices[0].message.content.trim();

    // Robust JSON extraction
    let parsed;
    const attempts = [
      raw,
      raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim(),
      raw.replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim(),
      raw.match(/\{[\s\S]*\}/)?.[0],
    ];

    for (const attempt of attempts) {
      if (!attempt) continue;
      try {
        parsed = JSON.parse(attempt);
        break;
      } catch {}
    }

    if (!parsed) {
      console.error("JSON parse failed. Raw output:", raw);
      return res.status(500).json({
        success: false,
        error: "AI returned invalid JSON. Please try again.",
        raw: raw.slice(0, 500),
      });
    }

    // Save to MongoDB
    const doc = new Analysis({
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

// ── GET /history — last 20 analyses ─────────────────────────────────────────
app.get("/history", async (req, res) => {
  try {
    const analyses = await Analysis.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .select("-resume");
    res.json({ success: true, analyses });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /history/:id — single analysis ──────────────────────────────────────
app.get("/history/:id", async (req, res) => {
  try {
    const doc = await Analysis.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, result: doc });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /history/:id ──────────────────────────────────────────────────────
app.delete("/history/:id", async (req, res) => {
  try {
    await Analysis.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

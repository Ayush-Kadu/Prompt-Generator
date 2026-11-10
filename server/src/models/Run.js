import mongoose from 'mongoose';

const PromptSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    keyword: String,
    category: { type: String, enum: ['Branded', 'Non-branded'] },
    intent: String,
    intentSource: String,
    sentiment: String,
    score: Number,
    grade: String,
    flags: [String],
    topic: String,
    location: String,
    language: String,
    source: { type: String, enum: ['ai', 'template', 'fallback', 'custom'] },
    selected: { type: Boolean, default: true },
  },
  { _id: false },
);

const RunSchema = new mongoose.Schema(
  {
    name: String,
    status: { type: String, enum: ['queued', 'running', 'cancelling', 'done', 'failed', 'cancelled'], default: 'queued' },
    origin: { type: String, default: 'ui' }, // ui | api
    settings: { type: mongoose.Schema.Types.Mixed, required: true },
    keywords: [String],
    profile: mongoose.Schema.Types.Mixed,
    prompts: [PromptSchema],
    target: Number,
    stats: mongoose.Schema.Types.Mixed,
    usage: mongoose.Schema.Types.Mixed,
    provider: String,
    model: String,
    warnings: [String],
    log: [{ at: String, msg: String, _id: false }],
    progress: mongoose.Schema.Types.Mixed, // live counters while running; null when finished
    error: String,
  },
  { timestamps: true },
);

export const Run = mongoose.models.Run || mongoose.model('Run', RunSchema);

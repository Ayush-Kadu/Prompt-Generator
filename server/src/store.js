// Run repository: MongoDB when MONGODB_URI connects, otherwise an in-memory
// map so the app still works on a machine without Mongo.
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Run } from './models/Run.js';

let useMongo = false;
const memory = new Map();

export async function connectStore(uri = process.env.MONGODB_URI) {
  if (!uri) {
    console.log('[store] MONGODB_URI not set — runs are kept in memory.');
    return 'memory';
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
    useMongo = true;
    console.log('[store] Connected to MongoDB.');
    return 'mongodb';
  } catch (err) {
    console.warn(`[store] MongoDB unavailable (${err.message}) — runs are kept in memory.`);
    return 'memory';
  }
}

export const storeKind = () => (useMongo ? 'mongodb' : 'memory');

const toPlain = (doc) => {
  if (!doc) return null;
  const o = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  o.id = String(o._id);
  delete o._id;
  delete o.__v;
  return o;
};

const SUMMARY = ['name', 'status', 'origin', 'target', 'stats', 'provider', 'model', 'createdAt'];

export async function createRun(data) {
  if (useMongo) return toPlain(await Run.create(data));
  const now = new Date();
  const run = { ...data, _id: randomUUID(), createdAt: now, updatedAt: now };
  memory.set(run._id, run);
  return toPlain(run);
}

export async function updateRun(id, patch) {
  if (useMongo) return toPlain(await Run.findByIdAndUpdate(id, patch, { new: true }).lean());
  const run = memory.get(id);
  if (!run) return null;
  Object.assign(run, patch, { updatedAt: new Date() });
  return toPlain(run);
}

export async function getRun(id) {
  if (useMongo) return mongoose.isValidObjectId(id) ? toPlain(await Run.findById(id).lean()) : null;
  return toPlain(memory.get(id));
}

export async function listRuns(limit = 30) {
  if (useMongo) {
    const docs = await Run.find({}, Object.fromEntries(SUMMARY.map((k) => [k, 1]))).sort({ createdAt: -1 }).limit(limit).lean();
    return docs.map(toPlain);
  }
  return [...memory.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((r) => toPlain(Object.fromEntries([...SUMMARY, '_id'].map((k) => [k, r[k]]))));
}

export async function deleteRun(id) {
  if (useMongo) return mongoose.isValidObjectId(id) ? Boolean(await Run.findByIdAndDelete(id)) : false;
  return memory.delete(id);
}

import multer from 'multer';
import { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import FileUtil from '../utils/fileUtil';
import getLogger from '../configs/logger';

const logger = getLogger();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads');
    // Create uploads directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename with timestamp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// File filter to validate file types
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  // Allow common file types - customize as needed
  const allowedMimeTypes = [
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'application/json',
    'image/jpeg',
    'image/png',
    'image/gif',
    'application/pdf'
  ];

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} is not allowed`));
  }
};

// Configure multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 5 // Maximum 5 files per request
  }
});

/**
 * Parse a multipart body to disk. Called by the pipeline only after the route matched and auth,
 * geo-fence and rate limits passed, so rejected requests never write a byte. Every file is deleted
 * when the response ends, whatever the outcome. Resolves to the files, or null after answering 400.
 */
export function parseMultipart(req: Request, res: Response): Promise<Express.Multer.File[] | null> {
  if (!String(req.get('content-type') || '').includes('multipart/form-data')) return Promise.resolve([]);
  return new Promise((resolve) => {
    res.once('close', () => FileUtil.cleanupFiles(Array.isArray(req.files) ? req.files : []));
    upload.any()(req, res, (err: unknown) => {
      if (err) {
        FileUtil.cleanupFiles(Array.isArray(req.files) ? req.files : []);
        logger.warn({ err: (err as Error).message }, 'multipart parse error');
        res.status(400).json({ error: 'File upload error', message: (err as Error).message });
        return resolve(null);
      }
      resolve(Array.isArray(req.files) ? req.files : []);
    });
  });
}

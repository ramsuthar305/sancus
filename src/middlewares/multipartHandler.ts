import multer from 'multer';
import { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';

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

// Middleware to handle multipart requests
export const handleMultipart = (req: Request, res: Response, next: NextFunction) => {
  // Check if the request is multipart/form-data
  const contentType = req.get('content-type');
  
  if (contentType && contentType.includes('multipart/form-data')) {
    // Use multer to handle the multipart request
    upload.any()(req, res, (err) => {
      if (err) {
        console.error('Multer error:', err);
        return res.status(400).json({
          error: 'File upload error',
          message: err.message
        });
      }
      
      // Add file information to request for later use
      if (req.files && Array.isArray(req.files)) {
        (req as any).uploadedFiles = req.files;
      }
      
      next();
    });
  } else {
    // Not a multipart request, continue with normal flow
    next();
  }
};

export default handleMultipart; 
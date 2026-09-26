import fs from 'fs';
import path from 'path';
import getLogger from '../configs/logger';

const logger = getLogger();

export interface FileValidationResult {
  isValid: boolean;
  error?: string;
  fileInfo?: {
    originalName: string;
    size: number;
    mimetype: string;
    path: string;
  };
}

export class FileUtil {
  private static allowedMimeTypes = [
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

  private static maxFileSize = 10 * 1024 * 1024; // 10MB

  /**
   * Validate uploaded file
   */
  static validateFile(file: Express.Multer.File): FileValidationResult {
    try {
      // Check file size
      if (file.size > this.maxFileSize) {
        return {
          isValid: false,
          error: `File size ${file.size} bytes exceeds maximum allowed size of ${this.maxFileSize} bytes`
        };
      }

      // Check MIME type
      if (!this.allowedMimeTypes.includes(file.mimetype)) {
        return {
          isValid: false,
          error: `File type ${file.mimetype} is not allowed. Allowed types: ${this.allowedMimeTypes.join(', ')}`
        };
      }

      // Check if file exists
      if (!fs.existsSync(file.path)) {
        return {
          isValid: false,
          error: `File not found at path: ${file.path}`
        };
      }

      return {
        isValid: true,
        fileInfo: {
          originalName: file.originalname,
          size: file.size,
          mimetype: file.mimetype,
          path: file.path
        }
      };
    } catch (error) {
      return {
        isValid: false,
        error: `File validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Read file content as buffer
   */
  static readFileAsBuffer(filePath: string): Buffer {
    return fs.readFileSync(filePath);
  }

  /**
   * Read file content as string
   */
  static readFileAsString(filePath: string, encoding: BufferEncoding = 'utf8'): string {
    return fs.readFileSync(filePath, encoding);
  }

  /**
   * Clean up uploaded files
   */
  static cleanupFiles(files: Express.Multer.File[]): void {
    files.forEach(file => {
      try {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      } catch (error) {
        logger.warn({ err: (error as Error).message, path: file.path }, 'failed to delete upload');
      }
    });
  }

  /**
   * Get file extension from filename
   */
  static getFileExtension(filename: string): string {
    return path.extname(filename).toLowerCase();
  }

  /**
   * Check if file is CSV
   */
  static isCSVFile(file: Express.Multer.File): boolean {
    return file.mimetype === 'text/csv' || this.getFileExtension(file.originalname) === '.csv';
  }

  /**
   * Check if file is Excel
   */
  static isExcelFile(file: Express.Multer.File): boolean {
    return file.mimetype === 'application/vnd.ms-excel' || 
           file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
           ['.xls', '.xlsx'].includes(this.getFileExtension(file.originalname));
  }
}

export default FileUtil; 
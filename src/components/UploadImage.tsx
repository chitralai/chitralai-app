import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Upload } from '@aws-sdk/lib-storage';
import { s3ClientPromise, validateEnvVariables } from '../config/aws';
import { Upload as UploadIcon, X, Download, ArrowLeft, Copy, Loader2, Camera, ShieldAlert, Clock, Image as ImageIcon, AlertCircle, CheckCircle, Wifi, WifiOff } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getUserEvents, getEventById, updateEventData, convertToAppropriateUnit, addSizes, formatSize } from '../config/eventStorage';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createCollection, indexFaces, indexFacesBatch } from '../services/faceRecognition';
import { isImageFile, validateImageFile, needsConversion, getTargetFormat, getImageFormatInfo } from '../utils/imageFormats';
import heic2any from 'heic2any';


// Add type declaration for directory upload attributes
declare module 'react' {
  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    webkitdirectory?: string;
    directory?: string;
  }
}

// Add types for upload progress tracking
interface UploadProgress {
  current: number;
  total: number;
  status?: string;
  currentFile?: string;
  estimatedTimeRemaining?: number; // in seconds
  uploadSpeed?: number; // in bytes per second
  stage: 'optimizing' | 'uploading'; // Removed indexing stage
  processedBytes: number;
  totalBytes: number;
  startTime: number;
  optimizationStartTime: number;
  processedImages: number;
}

interface FileProgress {
  fileName: string;
  size: number;
  compressedSize?: number;
  compressionStartTime?: number;
  compressionEndTime?: number;
  uploadStartTime?: number;
  uploadEndTime?: number;
  uploadedBytes: number;
}

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
const BATCH_SIZE = 5; // Process 5 images at a time
const IMAGES_PER_PAGE = 20;
const MAX_PARALLEL_UPLOADS = 20; // Increased for faster parallel processing
const MAX_DIMENSION = 2048;
const UPLOAD_TIMEOUT = 300000; // 5 minutes timeout for large files
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY = 2000;
const MAX_RETRY_DELAY = 30000;
const JITTER_MAX = 1000;
const MEMORY_THRESHOLD = 0.8; // 80% memory usage threshold

// Add helper function to format file size
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

// Helper function to add jitter to retry delay
const getRetryDelay = (retryCount: number): number => {
  const exponentialDelay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
  const delay = Math.min(exponentialDelay, MAX_RETRY_DELAY);
  const jitter = Math.random() * JITTER_MAX;
  return delay + jitter;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Add error type constants
const UPLOAD_ERROR_TYPES = {
  VALIDATION: 'VALIDATION_ERROR',
  NETWORK: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT_ERROR',
  S3_ERROR: 'S3_ERROR',
  UNKNOWN: 'UNKNOWN_ERROR',
  INVALID_FILE_TYPE: 'INVALID_FILE_TYPE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE'
} as const;

type UploadErrorType = typeof UPLOAD_ERROR_TYPES[keyof typeof UPLOAD_ERROR_TYPES];

interface UploadError {
  type: UploadErrorType;
  message: string;
  details?: any;
  timestamp: number;
}

// Add error tracking
const uploadErrorTracker = {
  errors: new Map<string, UploadError[]>(),
  
  addError(fileName: string, error: UploadError) {
    if (!this.errors.has(fileName)) {
      this.errors.set(fileName, []);
    }
    this.errors.get(fileName)?.push(error);
  },
  
  getErrors(fileName: string) {
    return this.errors.get(fileName) || [];
  },
  
  clearErrors(fileName: string) {
    this.errors.delete(fileName);
  }
};

// Add this helper function near the top
const pollForCompressedImage = async (bucketUrl: string, compressedKey: string, maxAttempts = 15, interval = 2000): Promise<string | null> => {
  // Skip compression check for now and return the original image URL
  return `${bucketUrl}/${compressedKey}`;
};

// Add this helper function for getting a pre-signed URL
const getPresignedUrl = async (key: string, contentType: string): Promise<string> => {
  const response = await fetch('/api/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, contentType })
  });
  if (!response.ok) throw new Error('Failed to get pre-signed URL');
  const data = await response.json();
  return data.url;
};

const sanitizeFilename = (filename: string): string => {
  // First, handle special cases like (1), (2), etc.
  const hasNumberInParentheses = filename.match(/\(\d+\)$/);
  const numberInParentheses = hasNumberInParentheses ? hasNumberInParentheses[0] : '';
  
  // Remove the number in parentheses from the filename for sanitization
  const filenameWithoutNumber = filename.replace(/\(\d+\)$/, '');
  
  // Sanitize the main filename
  const sanitized = filenameWithoutNumber
    .replace(/[^a-zA-Z0-9_.\-:]/g, '_') // Replace invalid chars with underscore
    .replace(/_{2,}/g, '_') // Replace multiple underscores with single underscore
    .replace(/^_|_$/g, ''); // Remove leading/trailing underscores
  
  // Add back the number in parentheses if it existed
  return sanitized + numberInParentheses;
};

// Add helper function to format time
const formatTimeRemaining = (seconds: number): string => {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
};

// Add helper function to format upload speed
const formatUploadSpeed = (bytesPerSecond: number): string => {
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  } else if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  } else {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  }
};

// Add new interface for dual progress tracking
interface DualProgress {
  optimization: {
    current: number;
    total: number;
    processedBytes: number;
    totalBytes: number;
    estimatedTimeRemaining?: number;
  };
  upload: {
    current: number;
    total: number;
    processedBytes: number;
    totalBytes: number;
    uploadSpeed?: number;
    estimatedTimeRemaining?: number;
    currentFile?: string;
  };
  currentStage: 'optimization' | 'upload';
  overallEstimatedTime?: number;
}

const UploadImage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [images, setImages] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [eventId, setEventId] = useState<string>('');
  const [uploadedUrls, setUploadedUrls] = useState<string[]>([]);
  const [events, setEvents] = useState<{ id: string; name: string }[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<string>('');
  const [showQRModal, setShowQRModal] = useState(false);
  const [showCopySuccess, setShowCopySuccess] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [eventCode, setEventCode] = useState<string>('');
  const [isAuthorized, setIsAuthorized] = useState<boolean | null>(null);
  const [authorizationMessage, setAuthorizationMessage] = useState<string>('');
  const [totalSize, setTotalSize] = useState<number>(0);
  const [uploadType, setUploadType] = useState<'folder' | 'photos'>('photos');
  const [isDragging, setIsDragging] = useState(false);
  const [dualProgress, setDualProgress] = useState<DualProgress | null>(null);

  // Handle drag events
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const items = e.dataTransfer.items;
    const files: File[] = [];

    // Process dropped items
    const processEntry = async (entry: FileSystemEntry) => {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve) => {
          (entry as FileSystemFileEntry).file(resolve);
        });
        if (file.type.startsWith('image/')) {
          files.push(file);
        }
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const entries = await new Promise<FileSystemEntry[]>((resolve) => {
          reader.readEntries(resolve);
        });
        for (const childEntry of entries) {
          await processEntry(childEntry);
        }
      }
    };

    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const entry = item.webkitGetAsEntry();
          if (entry) {
            await processEntry(entry);
          }
        }
      }

      if (files.length > 0) {
        handleImageChange({ target: { files: files } } as any);
      }
    } catch (error) {
      console.error('Error processing dropped files:', error);
    }
  };

  // Add effect to handle post-login reload
  useEffect(() => {
    // Check if we just logged in by looking for a flag in sessionStorage
    const justLoggedIn = sessionStorage.getItem('justLoggedIn');
    const urlEventId = new URLSearchParams(window.location.search).get('eventId');
    
    if (justLoggedIn && urlEventId) {
      // Clear the flag
      sessionStorage.removeItem('justLoggedIn');
      // Reload the page to reinitialize everything
      window.location.reload();
    }
  }, []);

  // Function to check if the user is authorized to upload
  const checkAuthorization = useCallback(async (eventId: string) => {
    if (!eventId) {
      setIsAuthorized(null);
      setAuthorizationMessage('');
      return;
    }

    const userEmail = localStorage.getItem('userEmail');
    if (!userEmail) {
      setIsAuthorized(false);
      setAuthorizationMessage('You need to log in to upload images.');
      // Store the current URL for post-login redirect
      localStorage.setItem('pendingAction', 'getPhotos');
      localStorage.setItem('pendingRedirectUrl', window.location.href);
      return;
    }

    try {
      const event = await getEventById(eventId);
      if (!event) {
        setIsAuthorized(false);
        setAuthorizationMessage('Event not found with the provided code.');
        return;
      }

      // Check if user is the event creator
      if (event.organizerId === userEmail || event.userEmail === userEmail) {
        setIsAuthorized(true);
        setAuthorizationMessage('You are authorized as the event creator.');
        return;
      }

      // Check if user's email is in the emailAccess list
      if (event.emailAccess && Array.isArray(event.emailAccess) && event.emailAccess.includes(userEmail)) {
        setIsAuthorized(true);
        setAuthorizationMessage('You are authorized to upload to this event.');
        return;
      }

      // Check if anyone can upload is enabled
      if (event.anyoneCanUpload) {
        setIsAuthorized(true);
        setAuthorizationMessage('This event allows anyone to upload photos.');
        return;
      }

      // User is not authorized
      setIsAuthorized(false);
      setAuthorizationMessage('You are not authorized to upload images to this event.');
    } catch (error) {
      console.error('Error checking authorization:', error);
      setIsAuthorized(false);
      setAuthorizationMessage('Error checking authorization. Please try again.');
    }
  }, []);

  // Function to check event code authorization
  const checkEventCodeAuthorization = useCallback(async (code: string) => {
    if (!code) return;

    try {
      const event = await getEventById(code);
      if (!event) {
        setIsAuthorized(false);
        setAuthorizationMessage('Event not found with the provided code.');
        return;
      }

      // Set the event details
      setSelectedEvent(code);
      setEventId(code);
      localStorage.setItem('currentEventId', code);
      
      // Check authorization
      await checkAuthorization(code);
    } catch (error) {
      console.error('Error checking event code:', error);
      setIsAuthorized(false);
      setAuthorizationMessage('Error checking event code. Please try again.');
    }
  }, [checkAuthorization]);

  // Handle scroll for pagination
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    if (scrollHeight - scrollTop - clientHeight < 100) {
      setCurrentPage(prev => prev + 1);
    }
  }, []);

  useEffect(() => {
    const initializeComponent = async () => {
      // Check URL parameters first for eventId - do this before userEmail check
      const searchParams = new URLSearchParams(window.location.search);
      const urlEventId = searchParams.get('eventId');
      
      if (urlEventId) {
        console.log('EventId from URL params:', urlEventId);
        setEventCode(urlEventId);
        // Get event details to verify it exists and set the name
        try {
          const event = await getEventById(urlEventId);
          if (event) {
            // Add the event to the events list if it's not already there
            setEvents(prevEvents => {
              const eventExists = prevEvents.some(e => e.id === urlEventId);
              if (!eventExists) {
                return [...prevEvents, { id: urlEventId, name: event.name }];
              }
              return prevEvents;
            });
            setSelectedEvent(urlEventId);
            setEventId(urlEventId);
            localStorage.setItem('currentEventId', urlEventId);
          }
        } catch (error) {
          console.error('Error fetching event details:', error);
        }
        // Only check authorization if user is logged in
        const userEmail = localStorage.getItem('userEmail');
        if (userEmail) {
          checkEventCodeAuthorization(urlEventId);
        }
      }

      // Continue with user-specific initialization if logged in
      const userEmail = localStorage.getItem('userEmail');
      if (!userEmail) return;

      try {
        // Fetch user events
        const userEvents = await getUserEvents(userEmail);
        const eventsList = userEvents.map(event => ({
          id: event.id,
          name: event.name,
        }));
        
        // Merge with any event from URL that might not be in the user's list
        setEvents(prevEvents => {
          const combinedEvents = [...eventsList];
          const urlEvent = prevEvents.find(e => e.id === urlEventId);
          if (urlEvent && !eventsList.some(e => e.id === urlEventId)) {
            combinedEvents.push(urlEvent);
          }
          return combinedEvents;
        });

        // Extract eventId from state or localStorage if not already set from URL
        let targetEventId = urlEventId;
        
        if (!targetEventId) {
          // Check location state (from navigation)
          if (location.state?.eventId) {
            console.log('EventId from location state:', location.state.eventId);
            targetEventId = location.state.eventId;
          }
          // Check localStorage as last resort
          else {
            const storedEventId = localStorage.getItem('currentEventId');
            if (storedEventId) {
              console.log('EventId from localStorage:', storedEventId);
              targetEventId = storedEventId;
            }
          }
        }

        if (targetEventId) {
          // Find the event in the list to confirm it exists
          const eventExists = eventsList.some(event => event.id === targetEventId);
          
          if (eventExists) {
            setEventId(targetEventId);
            setSelectedEvent(targetEventId);
            console.log('Set selected event to:', targetEventId);
          } else {
            console.warn('Event ID from URL/state not found in user events:', targetEventId);
          }
        }
      } catch (error) {
        console.error('Error initializing UploadImage component:', error);
      }
    };

    initializeComponent();
  }, [location, checkEventCodeAuthorization]);

  // Find the current event name for display
  const getSelectedEventName = () => {
    const event = events.find(e => e.id === selectedEvent);
    return event ? event.name : 'Select an Event';
  };

  const handleImageChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      
      // Track duplicates and valid files
      const validFiles: File[] = [];
      const invalidFiles: { name: string; reason: string }[] = [];
      const duplicateFiles: string[] = [];
      const existingFileNames = new Set(images.map(img => img.name));
      let newTotalSize = 0;
      
      for (const file of files) {
        const fileName = file.name.toLowerCase();
        const isValidType = file.type.startsWith('image/');
        const isValidSize = file.size <= MAX_FILE_SIZE;
        const isNotSelfie = !fileName.includes('selfie') && !fileName.includes('self');
        const isDuplicate = existingFileNames.has(file.name);
        
        if (isDuplicate) {
          duplicateFiles.push(file.name);
          continue;
        }
        
        if (!isValidType) {
          invalidFiles.push({ name: file.name, reason: 'Not a valid image file' });
        } else if (!isValidSize) {
          invalidFiles.push({ name: file.name, reason: 'Exceeds the 200MB size limit' });
        } else if (!isNotSelfie) {
          invalidFiles.push({ name: file.name, reason: 'Selfie images are not allowed' });
        } else {
          // For folder uploads, preserve the folder structure
          if ('webkitRelativePath' in file) {
            // Remove the root folder name from the path
            const pathParts = (file as any).webkitRelativePath.split('/');
            pathParts.shift(); // Remove the root folder name
            const relativePath = pathParts.join('/');
            // Create new File object with the original name
            const fileWithPath = new File([file], file.name, { type: file.type });
            validFiles.push(fileWithPath);
          } else {
            validFiles.push(file);
          }
          newTotalSize += file.size;
          existingFileNames.add(file.name); // Add to set to prevent future duplicates
        }
      }

      // Show error messages for invalid files and duplicates
      let warningMessage = '';
      
      if (duplicateFiles.length > 0) {
        warningMessage += `${duplicateFiles.length} duplicate file(s) were skipped:\n${
          duplicateFiles.slice(0, 5).map(f => `- ${f}`).join('\n')
        }${duplicateFiles.length > 5 ? `\n...and ${duplicateFiles.length - 5} more` : ''}\n\n`;
      }
      
      if (invalidFiles.length > 0) {
        warningMessage += `${invalidFiles.length} invalid file(s) were skipped:\n${
          invalidFiles.slice(0, 5).map(f => `- ${f.name}: ${f.reason}`).join('\n')
        }${invalidFiles.length > 5 ? `\n...and ${invalidFiles.length - 5} more` : ''}`;
      }

      if (warningMessage) {
        alert(warningMessage);
      }

      // Only update state if we have valid files and no duplicates
      if (validFiles.length > 0 && duplicateFiles.length === 0) {
        setImages(prev => [...prev, ...validFiles]);
        setTotalSize(prev => prev + newTotalSize);
      }
    }
  }, [images]);

  const removeImage = useCallback((index: number) => {
    setImages(prev => {
      const removedFile = prev[index];
      setTotalSize(currentSize => currentSize - removedFile.size);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const clearAllFiles = useCallback(() => {
    setImages([]);
    setTotalSize(0);
  }, []);

  // Add memory management helper
  const checkMemoryUsage = async (): Promise<boolean> => {
    if ('performance' in window && 'memory' in performance) {
      const memory = (performance as any).memory;
      const usedHeap = memory.usedJSHeapSize;
      const totalHeap = memory.totalJSHeapSize;
      return usedHeap / totalHeap < MEMORY_THRESHOLD;
    }
    return true; // If memory API not available, assume OK
  };

  // Optimize uploadToS3 function with retry and error handling
  const uploadToS3WithRetry = async (
    file: File,
    fileName: string,
    retryCount = 0,
    lastError: Error | null = null
  ): Promise<string> => {
    try {
      // Sanitize the filename before upload
      const sanitizedFileName = sanitizeFilename(fileName);
      console.log('[DEBUG] UploadImage.tsx: Uploading with retry:', {
        originalName: fileName,
        sanitizedName: sanitizedFileName,
        retryCount
      });

      // Validate file before attempting upload using comprehensive image format support
      const validation = validateImageFile(file);
      if (!validation.isValid) {
        const error: UploadError = {
          type: UPLOAD_ERROR_TYPES.INVALID_FILE_TYPE,
          message: validation.error || 'Only image files are allowed',
          timestamp: Date.now()
        };
        uploadErrorTracker.addError(sanitizedFileName, error);
        throw new Error(error.message);
      }

      // Log format information for debugging
      if (validation.formatInfo) {
        console.log('[DEBUG] UploadImage.tsx: File format info:', {
          fileName: sanitizedFileName,
          format: validation.formatInfo.description,
          category: validation.formatInfo.category,
          needsConversion: validation.formatInfo.needsConversion,
          targetFormat: validation.formatInfo.targetFormat
        });
      }

      // Check file size
      if (file.size > MAX_FILE_SIZE) {
        const error: UploadError = {
          type: UPLOAD_ERROR_TYPES.FILE_TOO_LARGE,
          message: `File size exceeds ${formatFileSize(MAX_FILE_SIZE)}`,
          timestamp: Date.now()
        };
        uploadErrorTracker.addError(sanitizedFileName, error);
        throw new Error(error.message);
      }

      // Calculate timeout multiplier based on file size
      const timeoutMultiplier = Math.ceil(file.size / (1024 * 1024)); // 1 second per MB
      const currentTimeout = UPLOAD_TIMEOUT * timeoutMultiplier;

      const uploadPromise = uploadToS3(file, sanitizedFileName).catch(error => {
        // Classify S3 errors
        const s3Error: UploadError = {
          type: UPLOAD_ERROR_TYPES.S3_ERROR,
          message: error.message,
          details: error,
          timestamp: Date.now()
        };
        uploadErrorTracker.addError(sanitizedFileName, s3Error);
        throw error;
      });

      // Set up timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          const timeoutError: UploadError = {
            type: UPLOAD_ERROR_TYPES.TIMEOUT,
            message: `Upload timed out after ${Math.round(currentTimeout/1000)}s`,
            timestamp: Date.now()
          };
          uploadErrorTracker.addError(sanitizedFileName, timeoutError);
          reject(new Error('Upload timeout'));
        }, currentTimeout);
      });

      try {
        return await Promise.race([uploadPromise, timeoutPromise]) as string;
      } catch (error: any) {
        const currentError = error || lastError || new Error('Unknown error');
        
        // Handle network errors
        if (error.name === 'NetworkError' || error.message.includes('network')) {
          const networkError: UploadError = {
            type: UPLOAD_ERROR_TYPES.NETWORK,
            message: 'Network error occurred during upload',
            details: error,
            timestamp: Date.now()
          };
          uploadErrorTracker.addError(sanitizedFileName, networkError);
        }

        // Log detailed error information
        console.error(`Upload attempt ${retryCount + 1} failed for ${sanitizedFileName}:`, {
          error: currentError.message,
          retryCount,
          fileName: sanitizedFileName,
          fileSize: formatFileSize(file.size),
          errorHistory: uploadErrorTracker.getErrors(sanitizedFileName)
        });

        if (retryCount < MAX_RETRIES) {
          const delay = getRetryDelay(retryCount);
          console.log(`Retrying upload for ${sanitizedFileName} after ${Math.round(delay/1000)}s (attempt ${retryCount + 1}/${MAX_RETRIES})`);
          
          await sleep(delay);
          return uploadToS3WithRetry(file, sanitizedFileName, retryCount + 1, currentError);
        }

        // If we've exhausted all retries, throw an error with complete history
        const finalError = new Error(`Upload failed after ${MAX_RETRIES} retries. Error history: ${
          uploadErrorTracker.getErrors(sanitizedFileName)
            .map(err => `${err.type}: ${err.message}`)
            .join(', ')
        }`);
        throw finalError;
      }
    } catch (error: any) {
      throw error;
    }
  };

  // Optimized upload queue with parallel processing and memory management
  const uploadToS3WithRetryQueue = async (files: File[]): Promise<string[]> => {
    const results: string[] = [];
    const failedUploads: { file: File; error: Error }[] = [];
    const uploadQueue = [...files];
    const inProgress = new Set<string>();
    const maxConcurrent = 5; // Limit concurrent uploads
    let totalUploadedBytes = 0;
    let lastSpeedUpdate = Date.now();
    let lastUploadedBytes = 0;
    
    const updateUploadSpeed = () => {
      const now = Date.now();
      const timeDiff = (now - lastSpeedUpdate) / 1000; // Convert to seconds
      const bytesDiff = totalUploadedBytes - lastUploadedBytes;
      const speed = bytesDiff / timeDiff;
      
      // Calculate estimated time remaining
      const remainingBytes = files.reduce((sum, file) => sum + file.size, 0) - totalUploadedBytes;
      const estimatedTimeRemaining = speed > 0 ? remainingBytes / speed : 0;
      
      setUploadProgress(prev => ({
        ...prev!,
        uploadSpeed: speed,
        estimatedTimeRemaining: estimatedTimeRemaining,
        processedBytes: totalUploadedBytes,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0)
      }));
      
      lastSpeedUpdate = now;
      lastUploadedBytes = totalUploadedBytes;
    };
    
    const processFile = async (file: File): Promise<string> => {
      const fileName = file.name;
      let retryCount = 0;
      
      while (retryCount < MAX_RETRIES) {
        try {
          const result = await uploadToS3WithRetry(file, fileName);
          
          // Update progress
          totalUploadedBytes += file.size;
          updateUploadSpeed();
          
          return result;
        } catch (error) {
          retryCount++;
          if (retryCount >= MAX_RETRIES) {
            throw error;
          }
          await sleep(getRetryDelay(retryCount));
        }
      }
      
      throw new Error(`Upload failed after ${MAX_RETRIES} retries`);
    };
    
    const processQueue = async () => {
      while (uploadQueue.length > 0 || inProgress.size > 0) {
        // Fill up concurrent slots
        while (uploadQueue.length > 0 && inProgress.size < maxConcurrent) {
          const file = uploadQueue.shift()!;
          const fileName = file.name;
          
          inProgress.add(fileName);
          processFile(file)
            .then(result => {
              results.push(result);
              setUploadProgress(prev => ({
                ...prev!,
                current: results.length,
                total: files.length,
                stage: 'uploading',
                currentFile: fileName,
                processedBytes: totalUploadedBytes,
                totalBytes: files.reduce((sum, f) => sum + f.size, 0)
              }));
            })
            .catch(error => {
              failedUploads.push({ file, error });
              console.error(`Failed to upload ${fileName}:`, error);
            })
            .finally(() => {
              inProgress.delete(fileName);
            });
        }
        
        // Update upload speed every second
        if (Date.now() - lastSpeedUpdate >= 1000) {
          updateUploadSpeed();
        }
        
        // Wait before checking queue again
        await sleep(100);
        
        // Check memory usage
        if ('performance' in window && 'memory' in performance) {
          const memory = (performance as any).memory;
          if (memory.usedJSHeapSize / memory.totalJSHeapSize > MEMORY_THRESHOLD) {
            await sleep(1000); // Wait for GC
          }
        }
      }
    };
    
    await processQueue();
    
    if (failedUploads.length > 0) {
      console.error(`${failedUploads.length} uploads failed:`, failedUploads);
    }
    
    return results;
  };

  // Enhanced batch upload function with memory management
  const uploadBatchWithRetryQueue = async (batch: File[], startIndex: number): Promise<(string | null)[]> => {
    const { bucketName } = await validateEnvVariables();
    const results: (string | null)[] = new Array(batch.length).fill(null);
    const failedUploads: { file: File; index: number }[] = [];

    // Process files in smaller chunks to manage memory
    const chunkSize = 5;
    for (let i = 0; i < batch.length; i += chunkSize) {
      const chunk = batch.slice(i, i + chunkSize);
      
      // Check memory usage before processing chunk
      const memoryOK = await checkMemoryUsage();
      if (!memoryOK) {
        // Wait for garbage collection
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      const chunkResults = await Promise.allSettled(
        chunk.map(async (file, chunkIndex) => {
          const index = i + chunkIndex;
          try {
            // Get the original filename
            const originalFileName = file.name;
            // Split filename and extension
            const lastDotIndex = originalFileName.lastIndexOf('.');
            const nameWithoutExt = originalFileName.substring(0, lastDotIndex);
            const extension = originalFileName.substring(lastDotIndex);
            // Create safe filename while preserving extension and original name
            const safeFileName = nameWithoutExt.replace(/[^a-zA-Z0-9.-]/g, '_') + extension;
            const fileName = `${Date.now()}-${startIndex + index}-${safeFileName}`;
            console.log(`Uploading file: ${fileName} (Original: ${originalFileName})`);
            return await uploadToS3WithRetry(file, fileName);
          } catch (error) {
            console.error('Error processing file:', file.name, error);
            failedUploads.push({ file, index });
            return null;
          }
        })
      );

      // Process chunk results
      chunkResults.forEach((result, chunkIndex) => {
        const index = i + chunkIndex;
        if (result.status === 'fulfilled' && result.value) {
          results[index] = `https://${bucketName}.s3.amazonaws.com/${result.value}`;
        }
      });

      // Clear memory after each chunk
      if (global.gc) {
        global.gc();
      }
    }

    // Process failed uploads with exponential backoff
    let retryQueue = [...failedUploads];
    let retryAttempt = 0;
    
    while (retryQueue.length > 0 && retryAttempt < 3) {
      await sleep(getRetryDelay(retryAttempt));
      
      const currentQueue = [...retryQueue];
      retryQueue = [];

      for (const { file, index } of currentQueue) {
        try {
          const safeFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
          const fileName = `${Date.now()}-retry${retryAttempt}-${index}-${safeFileName}`;
          const result = await uploadToS3WithRetry(file, fileName);
          results[index] = `https://${bucketName}.s3.amazonaws.com/${result}`;
        } catch (error) {
          retryQueue.push({ file, index });
        }
      }
      
      retryAttempt++;
    }

    return results;
  };

  // Add network speed detection
  const detectNetworkSpeed = async (): Promise<number> => {
    try {
      const startTime = Date.now();
      // Use a CORS-friendly endpoint for network speed detection
      const response = await fetch('https://httpbin.org/bytes/1024', {
        method: 'GET',
        mode: 'cors'
      });
      const blob = await response.blob();
      const endTime = Date.now();
      const durationInSeconds = (endTime - startTime) / 1000;
      const bitsLoaded = blob.size * 8;
      const speedBps = bitsLoaded / durationInSeconds;
      return speedBps / 8; // Convert to bytes per second
    } catch (error) {
      console.error('Error detecting network speed:', error);
      return 1000000; // Default to 1MB/s if detection fails
    }
  };

  // Modify the handleUpload function's upload progress tracking
  const handleUpload = useCallback(async () => {
    // Clear any lingering justLoggedIn flag to prevent unintended reloads
    sessionStorage.removeItem('justLoggedIn');

    // Prevent multiple concurrent uploads
    if (isUploading) {
      console.log('Upload already in progress');
      return;
    }

    if (images.length === 0) {
      alert('Please select at least one image to upload.');
      return;
    }
    if (!selectedEvent) {
      alert('Please select or create an event before uploading images.');
      return;
    }

    try {
      setIsUploading(true);
      setUploadSuccess(false);
      
      const uploadStartTime = Date.now();
      const totalCount = images.length;
      const totalBytes = images.reduce((sum, file) => sum + file.size, 0);
      
      // Detect network speed for better time estimation
      const networkSpeed = await detectNetworkSpeed();
      
      // Initialize dual progress with total counts
      setDualProgress({
        optimization: {
          current: 0,
          total: totalCount,
          processedBytes: 0,
          totalBytes,
          estimatedTimeRemaining: totalBytes / (2 * 1024 * 1024)
        },
        upload: {
          current: 0,
          total: totalCount,
          processedBytes: 0,
          totalBytes,
          uploadSpeed: networkSpeed,
          estimatedTimeRemaining: totalBytes / networkSpeed
        },
        currentStage: 'optimization'
      });

      // Get existing images from the event to check for duplicates
      const currentEvent = await getEventById(selectedEvent);
      if (!currentEvent) {
        throw new Error('Event not found');
      }

      // Create a collection for the event if it doesn't exist
      await createCollection(selectedEvent);

      // Get existing image names from S3
      const existingImages = new Set();
      if (currentEvent.photoCount > 0) {
        // List objects in the event's S3 directory
        const s3Client = await s3ClientPromise;
        const { bucketName } = await validateEnvVariables();
        const listCommand = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: `events/shared/${selectedEvent}/images/`
        });
        
        const listedObjects = await s3Client.send(listCommand);
        if (listedObjects.Contents) {
          listedObjects.Contents.forEach(obj => {
            if (obj.Key) {
              const fileName = obj.Key.split('/').pop();
              if (fileName) {
                existingImages.add(fileName);
              }
            }
          });
        }
      }
      
      // Get total number of unique images for progress calculation
      const uniqueImages = images.filter(file => !existingImages.has(file.name));
      const totalUniqueCount = uniqueImages.length;
      const totalUniqueBytes = uniqueImages.reduce((sum, file) => sum + file.size, 0);

      // Check for duplicates and alert user
      if (uniqueImages.length === 0) {
        alert('All selected images are duplicates. No new images to upload.');
        setIsUploading(false);
        return;
      }

      if (uniqueImages.length < images.length) {
        const duplicateCount = images.length - uniqueImages.length;
        alert(`${duplicateCount} duplicate image(s) were skipped. Only ${uniqueImages.length} unique image(s) will be uploaded.`);
      }

      // Process images in batches
      const batches = [];
      for (let i = 0; i < uniqueImages.length; i += BATCH_SIZE) {
        batches.push(uniqueImages.slice(i, i + BATCH_SIZE));
      }

      let totalProcessedBytes = 0;
      let totalCompressedBytes = 0;
      let totalUploadedBytes = 0;
      let totalUploadedCount = 0;
      const allUploadedUrls = [];

      // Calculate total compressed size first
      for (const file of uniqueImages) {
        try {
          const compressedBlob = await compressImage(file);
          totalCompressedBytes += compressedBlob.size;
          URL.revokeObjectURL(URL.createObjectURL(compressedBlob));
        } catch (error) {
          totalCompressedBytes += file.size; // Use original size if compression fails
        }
      }

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        const batchStartIndex = batchIndex * BATCH_SIZE;
        
        // 1. Compress batch
        const compressedFiles = [];
        for (let i = 0; i < batch.length; i++) {
          const file = batch[i];
          const globalIndex = batchStartIndex + i;
          
          try {
            const startTime = Date.now();
            const compressedBlob = await compressImage(file);
            const compressedFile = new File([compressedBlob], file.name, { type: file.type });
            compressedFiles.push(compressedFile);
            
            totalProcessedBytes += file.size;

            // Update optimization progress based on total unique images
            const timePerByte = (Date.now() - startTime) / file.size;
            const remainingBytes = totalUniqueBytes - totalProcessedBytes;
            const estimatedRemainingTime = timePerByte * remainingBytes / 1000;

            setDualProgress(prev => ({
              ...prev!,
              optimization: {
                ...prev!.optimization,
                current: globalIndex + 1,
                total: totalUniqueCount,
                processedBytes: totalProcessedBytes,
                totalBytes: totalUniqueBytes,
                estimatedTimeRemaining: estimatedRemainingTime
              },
              currentStage: 'optimization'
            }));

            URL.revokeObjectURL(URL.createObjectURL(compressedBlob));
          } catch (error) {
            console.error('Error compressing file:', file.name, error);
            compressedFiles.push(file);
            totalProcessedBytes += file.size;
          }
        }

        // 2. Upload batch
        setDualProgress(prev => ({
          ...prev!,
          currentStage: 'upload',
          upload: {
            ...prev!.upload,
            current: totalUploadedCount,
            total: totalUniqueCount,
            processedBytes: totalUploadedBytes,
            totalBytes: totalCompressedBytes // Use total compressed size for all images
          }
        }));

        const batchUploadStartTime = Date.now();
        
        // Upload files one by one to track progress accurately
        for (const file of compressedFiles) {
          try {
            const uploadResult = await uploadToS3WithRetry(file, file.name);
            allUploadedUrls.push(uploadResult);
            
            totalUploadedBytes += file.size;
            totalUploadedCount++;

            // Update upload progress after each file using total counts
            const uploadSpeed = totalUploadedBytes / ((Date.now() - uploadStartTime) / 1000);
            const remainingUploadBytes = totalCompressedBytes - totalUploadedBytes;
            const estimatedUploadTime = remainingUploadBytes / uploadSpeed;

            setDualProgress(prev => ({
              ...prev!,
              upload: {
                ...prev!.upload,
                current: totalUploadedCount,
                total: totalUniqueCount,
                processedBytes: totalUploadedBytes,
                totalBytes: totalCompressedBytes,
                uploadSpeed,
                estimatedTimeRemaining: estimatedUploadTime
              }
            }));
          } catch (error) {
            console.error('Error uploading file:', file.name, error);
          }
        }

        // 3. Index faces for this batch
        try {
          const imageKeys = allUploadedUrls
            .slice(-compressedFiles.length) // Get keys for current batch
            .filter((url): url is string => !!url)
            .map(url => {
              const urlObj = new URL(url);
              return decodeURIComponent(urlObj.pathname.substring(1));
            });

          if (imageKeys.length > 0) {
            await indexFacesBatch(selectedEvent, imageKeys);
          }
        } catch (indexError) {
          console.error('Error during face indexing for batch:', indexError);
        }

        // Clear memory after each batch
        compressedFiles.length = 0;
        if (global.gc) {
          global.gc();
        }
      }

      // Update the event data in DynamoDB
      const userEmail = localStorage.getItem('userEmail');
      if (userEmail) {
        const updatedEvent = await getEventById(selectedEvent);
        if (updatedEvent) {
          const totalOriginalSize = (updatedEvent.totalImageSize || 0) + totalBytes;
          const totalCompressedSize = (updatedEvent.totalCompressedSize || 0) + totalCompressedBytes;
          
          const originalSize = convertToAppropriateUnit(totalOriginalSize);
          const compressedSize = convertToAppropriateUnit(totalCompressedSize);
          
          await updateEventData(selectedEvent, userEmail, {
            photoCount: (updatedEvent.photoCount || 0) + allUploadedUrls.length,
            totalImageSize: originalSize.size,
            totalImageSizeUnit: originalSize.unit,
            totalCompressedSize: compressedSize.size,
            totalCompressedSizeUnit: compressedSize.unit
          });
        }
      }

      // Mark upload as complete
      setUploadSuccess(true);
      setShowQRModal(true);
      setImages([]);
      setTotalSize(0);
      setUploadedUrls(allUploadedUrls);

    } catch (error: unknown) {
      console.error('Error during upload:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
      alert(`An error occurred during upload: ${errorMessage}`);
    } finally {
      setIsUploading(false);
      setDualProgress(null);
    }
  }, [images, selectedEvent]);

  const handleDownload = useCallback(async (url: string) => {
    try {
      const response = await fetch(url, {
        mode: 'cors',
        headers: {
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        const errorMessage = `Failed to download image (${response.status}): ${response.statusText}`;
        console.error(errorMessage);
        alert(errorMessage);
        throw new Error(errorMessage);
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('image/')) {
        const errorMessage = 'Invalid image format received';
        console.error(errorMessage);
        alert(errorMessage);
        throw new Error(errorMessage);
      }

      const blob = await response.blob();
      const fileName = decodeURIComponent(url.split('/').pop() || 'image.jpg');

      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(link.href);
      console.log(`Successfully downloaded: ${fileName}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'An unexpected error occurred while downloading the image';
      console.error('Error downloading image:', error);
      alert(errorMessage);
      throw error;
    }
  }, []);

  const handleDownloadAll = useCallback(async () => {
    const downloadPromises = uploadedUrls.map(url =>
      handleDownload(url).catch(error => ({ error, url }))
    );
    const results = await Promise.allSettled(downloadPromises);

    let successCount = 0;
    let failedUrls: string[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        successCount++;
      } else {
        failedUrls.push(uploadedUrls[index]);
      }
    });

    if (failedUrls.length === 0) {
      alert(`Successfully downloaded all ${successCount} images!`);
    } else {
      alert(`Downloaded ${successCount} images. Failed to download ${failedUrls.length} images. Please try again later.`);
    }
  }, [uploadedUrls, handleDownload]);

  const handleCopyLink = useCallback(() => {
    const link = `${window.location.origin}/attendee-dashboard?eventId=${selectedEvent}`;
    navigator.clipboard.writeText(link);
    setShowCopySuccess(true);
    setTimeout(() => setShowCopySuccess(false), 2000);
  }, [selectedEvent]);

  const handleDownloadQR = useCallback(() => {
    try {
      const canvas = document.createElement('canvas');
      const svg = document.querySelector('.qr-modal svg');
      if (!svg) {
        throw new Error('QR code SVG element not found');
      }
      const svgData = new XMLSerializer().serializeToString(svg);
      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Could not get canvas context');
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (!blob) {
            throw new Error('Could not create image blob');
          }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `selfie-upload-qr-${selectedEvent}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 'image/png');
      };
      img.src = 'data:image/svg+xml;base64,' + btoa(svgData);
    } catch (error) {
      console.error('Error downloading QR code:', error);
      alert('Failed to download QR code. Please try again.');
    }
  }, [selectedEvent]);

  // Add event handler for the event code input
  const handleEventCodeSubmit = useCallback(async () => {
    if (!eventCode) {
      alert('Please enter an event code.');
      return;
    }

    const userEmail = localStorage.getItem('userEmail');
    if (!userEmail) {
      // Store the current URL in localStorage for redirect after login
      localStorage.setItem('pendingRedirectUrl', window.location.href);
      // Set a flag to indicate we need to reload after login
      sessionStorage.setItem('justLoggedIn', 'true');
    }

    await checkEventCodeAuthorization(eventCode);
  }, [eventCode, checkEventCodeAuthorization]);

  // Check authorization when event is selected from dropdown
  useEffect(() => {
    if (selectedEvent) {
      checkAuthorization(selectedEvent);
    }
  }, [selectedEvent, checkAuthorization]);

  return (
    <div className="relative bg-grey-100 min-h-screen">
      {/* Add spacer div to push content below navbar */}
      <div className="h-14 sm:h-16 md:h-20"></div>
      
      <div className="container mx-auto px-4 py-2 relative z-10 mt-4">
        <video autoPlay loop muted className="fixed top-0 left-0 w-full h-full object-cover opacity-100 -z-10">
          <source src="tiny.mp4" type="video/mp4" />
          Your browser does not support the video tag.
        </video>
        <div className="relative z-10 container mx-auto px-4 py-4">
          <div className="max-w-lg mx-auto bg-white p-3 sm:p-5 rounded-lg shadow-md border-4 border-blue-900">
            <div className="flex flex-col items-center justify-center mb-4 sm:mb-6 space-y-4">
              {/* Event selection dropdown */}
              <select
                value={selectedEvent}
                onChange={(e) => {
                  const newEventId = e.target.value;
                  setSelectedEvent(newEventId);
                  setEventId(newEventId);
                  if (newEventId) {
                    localStorage.setItem('currentEventId', newEventId);
                  }
                }}
                className="border border-blue-400 rounded-lg px-4 py-2 w-full max-w-md text-black focus:outline-none focus:border-blue-900 bg-white"
              >
                <option value="">Select an Event</option>
                {events.map(event => (
                  <option key={event.id} value={event.id}>
                    {event.name}
                  </option>
                ))}
              </select>

              {/* Or text divider */}
              <div className="flex items-center w-full max-w-md">
                <div className="flex-grow h-px bg-gray-300"></div>
                <span className="px-4 text-gray-500 text-sm">OR</span>
                <div className="flex-grow h-px bg-gray-300"></div>
              </div>

              {/* Event code input */}
              <div className="flex flex-col sm:flex-row w-full max-w-md space-y-2 sm:space-y-0 sm:space-x-2">
                <input
                  type="text"
                  value={eventCode}
                  onChange={(e) => setEventCode(e.target.value)}
                  placeholder="Enter Event Code"
                  className="w-full border border-blue-400 rounded-lg px-4 py-2 text-black focus:outline-none focus:border-blue-900 bg-white"
                />
                <button
                  onClick={handleEventCodeSubmit}
                  className="w-full sm:w-auto px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors duration-200 font-medium min-w-[90px]"
                >
                  Access
                </button>
              </div>

              {/* Upload type selector */}
              <div className="flex justify-center space-x-4 w-full max-w-md mb-4">
                <button
                  onClick={() => setUploadType('photos')}
                  className={`px-4 py-2 rounded-lg ${uploadType === 'photos' ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-700'} transition-colors duration-200`}
                >
                  Photos
                </button>
                <button
                  onClick={() => setUploadType('folder')}
                  className={`px-4 py-2 rounded-lg ${uploadType === 'folder' ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-700'} transition-colors duration-200`}
                >
                  Folder
                </button>
              </div>

              {/* Drag and drop zone */}
              <div
                className={`w-full max-w-md border-2 border-dashed rounded-lg p-8 text-center transition-colors ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'}`}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  multiple
                  accept="image/*,.heic,.heif,.raw,.cr2,.nef,.arw,.orf,.dng,.rw2,.pef,.srw,.psd,.ai,.eps,.indd,.sketch,.fig,.tga,.pcx,.xcf,.kra,.cdr,.afphoto,.afdesign"
                  onChange={handleImageChange}
                  className="hidden"
                  {...(uploadType === 'folder' ? { webkitdirectory: '', directory: '' } : {})}
                />
                <div className="space-y-4">
                  <div className="flex justify-center">
                    <UploadIcon className={`w-12 h-12 ${isDragging ? 'text-blue-500' : 'text-gray-400'}`} />
                  </div>
                  <div>
                    <p className="text-lg font-medium text-gray-700">
                      {isDragging ? 'Drop your files here' : 'Drag and drop your files here'}
                    </p>
                    <p className="mt-1 text-sm text-gray-500">
                      or
                    </p>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="mt-2 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    >
                      {uploadType === 'folder' ? 'Select Folder' : 'Select Photos'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Authorization status message */}
              {isAuthorized !== null && localStorage.getItem('userEmail') && (
                <div className={`w-full max-w-md p-3 rounded-lg text-sm ${
                  isAuthorized 
                    ? 'bg-green-100 text-green-800 border border-green-300' 
                    : 'bg-red-100 text-red-800 border border-red-300'
                }`}>
                  <div className="flex items-center space-x-2">
                    {isAuthorized 
                      ? <div className="bg-green-200 p-1 rounded-full"><Camera className="w-4 h-4 text-green-700" /></div>
                      : <div className="bg-red-200 p-1 rounded-full"><ShieldAlert className="w-4 h-4 text-red-700" /></div>
                    }
                    <span>{authorizationMessage}</span>
                  </div>
                </div>
              )}

              {/*<h2 className="text-xl sm:text-2xl font-bold text-black text-center">Upload Images</h2>*/}
            </div>
            <div className="space-y-4">
              {/* Only show upload section if authorized */}
              {!localStorage.getItem('userEmail') ? (
                <div className="text-center py-8">
                  <div className="bg-red-100 p-6 rounded-lg inline-flex flex-col items-center">
                    <ShieldAlert className="w-12 h-12 text-red-500 mb-4" />
                    <p className="text-red-700 mt-2">
                      You need to log in to upload images.
                    </p>
                  </div>
                </div>
              ) : isAuthorized === true ? (
                <>
                  <div className="space-y-4">
                    {/* Upload Buttons */}
                    <div className="flex flex-col sm:flex-row gap-4 w-full justify-center">
                      {/* Upload Photos Button */}
                      <div className="relative w-full sm:w-1/2">
                        <input
                          type="file"
                          multiple
                          accept="image/*,.heic,.heif,.raw,.cr2,.nef,.arw,.orf,.dng,.rw2,.pef,.srw,.psd,.ai,.eps,.indd,.sketch,.fig,.tga,.pcx,.xcf,.kra,.cdr,.afphoto,.afdesign"
                          onChange={handleImageChange}
                          className="hidden"
                          id="photo-upload"
                          disabled={!isAuthorized || isUploading}
                        />
                        {/*
                        <label
                          htmlFor="photo-upload"
                          className={`flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 w-full cursor-pointer ${(!isAuthorized || isUploading) ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          <UploadIcon className="w-5 h-5 mr-2" />
                          Upload Photos
                        </label>
                        */}
                      </div>

                      {/* Upload Folder Button */}
                      <div className="relative w-full sm:w-1/2">
                        <input
                          type="file"
                          multiple
                          accept="image/*,.heic,.heif,.raw,.cr2,.nef,.arw,.orf,.dng,.rw2,.pef,.srw,.psd,.ai,.eps,.indd,.sketch,.fig,.tga,.pcx,.xcf,.kra,.cdr,.afphoto,.afdesign"
                          onChange={handleImageChange}
                          className="hidden"
                          id="folder-upload"
                          webkitdirectory=""
                          directory=""
                          disabled={!isAuthorized || isUploading}
                        />
                        {/*
                        <label
                          htmlFor="folder-upload"
                          className={`flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-400 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 w-full cursor-pointer ${(!isAuthorized || isUploading) ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          <UploadIcon className="w-5 h-5 mr-2" />
                          Upload Folder
                        </label>
                        */}
                      </div>
                    </div>
                  </div>

                  {/* Responsive file count and size display */}
                  {images.length > 0 && (
                    <div className="mt-4 bg-blue-50 rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="sm:flex sm:items-center">
                            <span className="font-medium text-blue-600 text-sm block">
                              {images.length} file{images.length !== 1 ? 's' : ''} selected
                            </span>
                            <span className="hidden sm:block mx-2 text-gray-400">•</span>
                            <span className="text-blue-600 text-sm block mt-1 sm:mt-0">
                              Total size: {formatFileSize(totalSize)}
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={clearAllFiles}
                          className="ml-3 whitespace-nowrap text-sm px-3 py-1 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-full transition-colors duration-200 flex-shrink-0"
                        >
                          Clear All
                        </button>
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleUpload}
                    disabled={isUploading || images.length === 0}
                    className={`w-full py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white ${
                      isUploading || images.length === 0 
                        ? 'bg-gray-400 cursor-not-allowed opacity-50' 
                        : 'bg-blue-500 hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500'
                    } transition-colors duration-200`}
                  >
                    {isUploading ? (
                      <span className="flex items-center justify-center">
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                        {dualProgress?.currentStage === 'optimization' && 'Optimizing'}
                        {dualProgress?.currentStage === 'upload' && 'Uploading'}
                        {' '}
                        {dualProgress?.optimization.current}/{dualProgress?.optimization.total}
                      </span>
                    ) : images.length === 0 ? (
                      'Select images to upload'
                    ) : (
                      `Upload ${images.length} Image${images.length > 1 ? 's' : ''}`
                    )}
                  </button>

                  {isUploading && dualProgress && (
                    <div className="mt-4 space-y-4">
                      {/* Combined Time Estimate */}
                      <div className="text-sm text-gray-600 flex justify-between items-center">
                        <div className="flex items-center">
                          <Clock className="w-4 h-4 mr-2" />
                          <span>Estimated time remaining: {formatTimeRemaining(
                            (dualProgress.optimization.estimatedTimeRemaining || 0) + 
                            (dualProgress.upload.estimatedTimeRemaining || 0)
                          )}</span>
                        </div>
                        {dualProgress.upload.uploadSpeed !== undefined && (
                          <span className="text-xs">Upload speed: {formatUploadSpeed(dualProgress.upload.uploadSpeed)}</span>
                        )}
                      </div>

                      {/* Optimization Progress */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm text-gray-600">
                          <span>Optimizing Images</span>
                          <span>{Math.round((dualProgress.optimization.processedBytes / dualProgress.optimization.totalBytes) * 100)}%</span>
                        </div>
                        <div className="w-full bg-gray-200 rounded-full h-2.5">
                          <div 
                            className="bg-blue-600 h-2.5 rounded-full transition-all duration-300" 
                            style={{ 
                              width: `${Math.round((dualProgress.optimization.processedBytes / dualProgress.optimization.totalBytes) * 100)}%` 
                            }}
                          />
                        </div>
                      </div>

                      {/* Upload Progress */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm text-gray-600">
                          <span>Uploading to Cloud</span>
                          <span>{Math.round((dualProgress.upload.processedBytes / dualProgress.upload.totalBytes) * 100)}%</span>
                        </div>
                        <div className="w-full bg-gray-200 rounded-full h-2.5">
                          <div 
                            className="bg-blue-600 h-2.5 rounded-full transition-all duration-300" 
                            style={{ 
                              width: `${Math.round((dualProgress.upload.processedBytes / dualProgress.upload.totalBytes) * 100)}%` 
                            }}
                          />
                        </div>
                      </div>

          
                    </div>
                  )}
                </>
              ) : isAuthorized === false ? (
                <div className="text-center py-8">
                  <div className="bg-red-100 p-6 rounded-lg inline-flex flex-col items-center">
                    <ShieldAlert className="w-12 h-12 text-red-500 mb-4" />
                    <h3 className="text-lg font-medium text-red-800">Access Denied</h3>
                    <p className="text-red-700 mt-2 max-w-md">
                      You don't have permission to upload images to this event. 
                      Please contact the event organizer to request access.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  Please select an event or enter an event code to continue.
                </div>
              )}
            </div>
            
            {/* QR Modal and other existing components */}
            {showQRModal && (
              <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999] p-4 overflow-y-auto">
                <div className="bg-blue-300 rounded-lg p-4 sm:p-6 max-w-sm w-full relative mx-auto mt-20 md:mt-0 mb-20 md:mb-0">
                  <div className="absolute top-2 right-2">
                    <button 
                      onClick={() => setShowQRModal(false)} 
                      className="bg-white rounded-full p-1 text-gray-500 hover:text-gray-700 shadow-md hover:bg-gray-100 transition-colors"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  <div className="flex flex-col items-center space-y-4 pt-6">                    
                    <h3 className="text-lg sm:text-xl font-semibold text-center">Share Event</h3>
                    <p className="text-sm text-blue-700 mb-2 text-center px-2">Share this QR code or link with others to let them find their photos</p>
                    <div className="qr-modal relative bg-white p-3 rounded-lg mx-auto flex justify-center">
                      <QRCodeSVG
                        value={`${window.location.origin}/attendee-dashboard?eventId=${selectedEvent}`}
                        size={180}
                        level="H"
                        includeMargin={true}
                        bgColor="#FFFFFF"
                        fgColor="#000000"
                      />
                      <button
                        onClick={() => {
                          const canvas = document.createElement('canvas');
                          const qrCode = document.querySelector('.qr-modal svg');
                          if (!qrCode) return;
                          
                          const serializer = new XMLSerializer();
                          const svgStr = serializer.serializeToString(qrCode);
                          
                          const img = new Image();
                          img.src = 'data:image/svg+xml;base64,' + btoa(svgStr);
                          
                          img.onload = () => {
                            canvas.width = img.width;
                            canvas.height = img.height;
                            const ctx = canvas.getContext('2d');
                            if (!ctx) return;
                            
                            ctx.fillStyle = '#FFFFFF';
                            ctx.fillRect(0, 0, canvas.width, canvas.height);
                            ctx.drawImage(img, 0, 0);
                            
                            canvas.toBlob((blob) => {
                              if (!blob) return;
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `qr-code-${selectedEvent}.png`;
                              document.body.appendChild(a);
                              a.click();
                              document.body.removeChild(a);
                              URL.revokeObjectURL(url);
                            }, 'image/png');
                          };
                        }}
                        className="absolute top-0 right-0 -mt-2 -mr-2 p-1 bg-white rounded-full shadow-md hover:bg-gray-50 transition-colors"
                        title="Download QR Code"
                      >
                        <Download className="w-4 h-4 text-gray-600" />
                      </button>
                    </div>
                    <div className="w-full">
                      <div className="flex items-center justify-between gap-2 p-2 bg-gray-50 rounded">
                        <input
                          type="text"
                          readOnly
                          value={`${window.location.origin}/attendee-dashboard?eventId=${selectedEvent}`}
                          className="flex-1 bg-transparent text-sm overflow-hidden text-ellipsis outline-none"
                        />
                        <button 
                          onClick={handleCopyLink} 
                          className="px-3 py-1.5 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors flex items-center gap-1 flex-shrink-0"
                        >
                          <Copy className="w-4 h-4" />
                          Copy
                        </button>
                      </div>
                      {showCopySuccess && <p className="text-sm text-green-600 mt-1 text-center">Link copied to clipboard!</p>}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default UploadImage;

// Remove the old convertHeicToJpeg function and replace compressImage with this:
const compressImage = async (file: File): Promise<Blob> => {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('Invalid file type for compression');
  }

  // Check if it's a HEIC file
  const isHeic = file.type === 'image/heic' || file.type === 'image/heif' ||
    file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif');

  if (isHeic) {
    try {
      // Convert HEIC to JPEG using heic2any
      const jpegBlob = await heic2any({
        blob: file,
        toType: 'image/jpeg',
        quality: 0.8,
      }) as Blob;
      return jpegBlob;
    } catch (error) {
      throw new Error('Failed to convert HEIC image to JPEG in browser');
    }
  }

  // For non-HEIC files, use the standard compression
  return new Promise<Blob>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      if (!e.target?.result) {
        reject(new Error('Failed to read file for compression'));
        return;
      }
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }
        let width = img.width;
        let height = img.height;
        const maxDimension = MAX_DIMENSION;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = (height / width) * maxDimension;
            width = maxDimension;
          } else {
            width = (width / height) * maxDimension;
            height = maxDimension;
          }
        }
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (blob && blob.size > 0) {
              resolve(blob);
            } else {
              reject(new Error('Failed to compress image - blob is null or empty'));
            }
          },
          'image/jpeg',
          0.8
        );
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
};

// Add uploadToS3 function before the UploadImage component
const uploadToS3 = async (file: File, fileName: string): Promise<string> => {
  try {
    const { bucketName } = await validateEnvVariables();
    const s3Client = await s3ClientPromise;
    const eventId = localStorage.getItem('currentEventId');
    
    if (!eventId) {
      throw new Error('No event ID found');
    }

    // Sanitize the filename
    const sanitizedFileName = sanitizeFilename(fileName);
    
    // For HEIC files, ensure we use a .jpg extension for better compatibility
    let finalFileName = sanitizedFileName;
    if (file.type === 'image/heic' || file.type === 'image/heif' || fileName.toLowerCase().endsWith('.heic') || fileName.toLowerCase().endsWith('.heif')) {
      const nameWithoutExt = finalFileName.replace(/\.(heic|heif)$/i, '');
      finalFileName = `${nameWithoutExt}.jpg`;
    }
    
    const key = `events/shared/${eventId}/images/${finalFileName}`;

    console.log('[DEBUG] UploadImage.tsx: Uploading file with:', {
      originalName: fileName,
      sanitizedName: sanitizedFileName,
      finalFileName: finalFileName,
      key: key,
      fileType: file.type,
      fileSize: file.size
    });

    // Convert File to ArrayBuffer to ensure proper format for S3 upload
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucketName,
        Key: key,
        Body: uint8Array,
        ContentType: 'image/jpeg', // Always use JPEG for better compatibility with AWS Rekognition
        ACL: 'public-read'
      },
      partSize: 1024 * 1024 * 5
    });

    await upload.done();
    console.log('[DEBUG] UploadImage.tsx: Successfully uploaded:', key);
    return `https://${bucketName}.s3.amazonaws.com/${key}`;
  } catch (error: any) {
    console.error('[ERROR] UploadImage.tsx: Failed to upload to S3:', {
      error: error.message,
      fileName,
      eventId: localStorage.getItem('currentEventId'),
      fileType: file.type,
      fileSize: file.size
    });
    throw error;
  }
};
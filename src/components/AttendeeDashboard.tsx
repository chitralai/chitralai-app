import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Camera, Calendar, Image as ImageIcon, X, Search, Download, Share2, Facebook, Instagram, Twitter, Linkedin, MessageCircle, Mail, Link, QrCode } from 'lucide-react';
import QRCodeScanner from './QRCodeScanner';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { s3ClientPromise, rekognitionClientPromise, validateEnvVariables } from '../config/aws';
import { CompareFacesCommand } from '@aws-sdk/client-rekognition';
import { getEventById } from '../config/eventStorage';
import { storeAttendeeImageData } from '../config/attendeeStorage';
import { searchFacesByImage } from '../services/faceRecognition';

interface Event {
  eventId: string;
  eventName: string;
  eventDate: string;
  thumbnailUrl: string;
  coverImage?: string;
}

interface MatchingImage {
  imageId: string;
  eventId: string;
  eventName: string;
  imageUrl: string;
  matchedDate: string;
  similarity: number;
}

interface Statistics {
  totalEvents: number;
  totalImages: number;
  firstEventDate: string | null;
  latestEventDate: string | null;
}

// Add interface for props
interface AttendeeDashboardProps {
  setShowSignInModal: (show: boolean) => void;
}

// Add helper function to deduplicate images
const deduplicateImages = (images: MatchingImage[]): MatchingImage[] => {
  const seen = new Set<string>();
  return images.filter(image => {
    const key = `${image.eventId}-${image.imageUrl}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

// Helper function to construct S3 URL
const constructS3Url = (imageUrl: string, bucket?: string): string => {
  // If it's already a full URL, return as is
  if (imageUrl.startsWith('http')) {
    return imageUrl;
  }
  // Use provided bucket name or default to chitral-ai
  const useBucket = bucket || 'chitral-ai';
  // Otherwise construct the URL using the bucket name
  return `https://${useBucket}.s3.amazonaws.com/${imageUrl}`;
};

const AttendeeDashboard: React.FC<AttendeeDashboardProps> = ({ setShowSignInModal }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const matchedImagesRef = React.useRef<HTMLDivElement>(null);
  const [selfieUrl, setSelfieUrl] = useState<string | null>(null);
  const [attendedEvents, setAttendedEvents] = useState<Event[]>([]);
  const [matchingImages, setMatchingImages] = useState<MatchingImage[]>([]);
  const [filteredImages, setFilteredImages] = useState<MatchingImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [statistics, setStatistics] = useState<Statistics>({
    totalEvents: 0,
    totalImages: 0,
    firstEventDate: null,
    latestEventDate: null
  });
  const [selectedEventFilter, setSelectedEventFilter] = useState<string>('all');
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  
  // New state variables for event code entry and selfie upload
  const [eventCode, setEventCode] = useState('');
  const [eventDetails, setEventDetails] = useState<{ id: string; name: string; date: string } | null>(null);
  const [selfie, setSelfie] = useState<File | null>(null);
  const [selfiePreview, setSelfiePreview] = useState<string | null>(null);
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventSortOption, setEventSortOption] = useState<'date' | 'name'>('date');
  
  // New state variables for camera functionality
  const [isCameraActive, setIsCameraActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [showCameraModal, setShowCameraModal] = useState(false);
  
  // New state for enlarged image modal
  const [selectedImage, setSelectedImage] = useState<MatchingImage | null>(null);

  // New state for share menu
  const [shareMenu, setShareMenu] = useState<{
    isOpen: boolean;
    imageUrl: string;
    position: { top: number; left: number };
  }>({
    isOpen: false,
    imageUrl: '',
    position: { top: 0, left: 0 }
  });

  // New state for QR code scanner
  const [showQRScanner, setShowQRScanner] = useState(false);

  const [selectedEvent, setSelectedEvent] = useState<string>('');
  const [selfieImage, setSelfieImage] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);

  // Toggle header and footer visibility when image is clicked
  const toggleHeaderFooter = (visible: boolean) => {
    // Find header and footer elements in DOM
    const header = document.querySelector('header');
    const footer = document.querySelector('footer');
    
    if (header) {
      if (visible) {
        header.classList.remove('hidden');
      } else {
        header.classList.add('hidden');
      }
    }
    
    if (footer) {
      if (visible) {
        footer.classList.remove('hidden');
      } else {
        footer.classList.add('hidden');
      }
    }
  };

  // Add a new useEffect to check authentication on page load
  useEffect(() => {
    // Check if user is logged in
    const userEmail = localStorage.getItem('userEmail');
    const searchParams = new URLSearchParams(location.search);
    const eventIdFromUrl = searchParams.get('eventId');
    
    // If user is not logged in and there's an event ID, show sign-in modal
    if (!userEmail) {
      if (eventIdFromUrl) {
        // Store information for redirect after login
        localStorage.setItem('pendingAction', 'getPhotos');
        localStorage.setItem('pendingRedirectUrl', window.location.href);
        // Set some visible state to show what event they're trying to access
        setEventCode(eventIdFromUrl);
        setProcessingStatus('Looking up event...');
        // Look up the event to show details
        getEventById(eventIdFromUrl).then(event => {
          if (event) {
            setEventDetails({
              id: event.id,
              name: event.name,
              date: event.date
            });
            setError('Please sign in to access your photos from this event.');
          } else {
            setError('Event not found. Please check the event code.');
          }
          setProcessingStatus(null);
        }).catch(err => {
          console.error('Error finding event:', err);
          setError('Error finding event. Please try again.');
          setProcessingStatus(null);
        });
      }
      // Show sign in modal
      setShowSignInModal(true);
    }
  }, []); // Empty dependency array ensures this runs only once on mount

  // Add new useEffect to handle URL parameters
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const eventIdFromUrl = searchParams.get('eventId');
    
    if (eventIdFromUrl) {
      setEventCode(eventIdFromUrl);
      // Create an async function to handle the event lookup
      const lookupEvent = async () => {
        try {
          setError(null);
          setEventDetails(null);
          setSuccessMessage(null);
          setProcessingStatus('Looking up event...');
          
          // Get user email if available
          const userEmail = localStorage.getItem('userEmail');
          
          // Try to get event by ID first
          let event = await getEventById(eventIdFromUrl);
          
          if (!event) {
            // Try with leading zeros if needed (for 6-digit codes)
            if (eventIdFromUrl.length < 6) {
              const paddedCode = eventIdFromUrl.padStart(6, '0');
              event = await getEventById(paddedCode);
            }
            
            // If it's exactly 6 digits, try without leading zeros
            if (eventIdFromUrl.length === 6 && eventIdFromUrl.startsWith('0')) {
              const unPaddedCode = eventIdFromUrl.replace(/^0+/, '');
              if (unPaddedCode) {
                event = await getEventById(unPaddedCode);
              }
            }
          }
          
          if (!event) {
            throw new Error(`Event with code "${eventIdFromUrl}" not found. Please check the code and try again.`);
          }
          
          // If user is not signed in, show event details and prompt to sign in
          if (!userEmail) {
            setEventDetails({
              id: event.id,
              name: event.name,
              date: event.date
            });
            setProcessingStatus(null);
            setError('Please sign in to access your photos from this event.');
            // Store complete URL for redirect after sign in
            localStorage.setItem('pendingAction', 'getPhotos');
            localStorage.setItem('pendingRedirectUrl', window.location.href);
            return;
          }
          
          // Check if user already has images for this event
          const { getAttendeeImagesByUserAndEvent } = await import('../config/attendeeStorage');
          const existingData = await getAttendeeImagesByUserAndEvent(userEmail, event.id);
          
          if (existingData) {
            // Handle existing data case
            handleExistingEventData(existingData, event);
          } else {
            // Show event details for new upload
            setEventDetails({
              id: event.id,
              name: event.name,
              date: event.date
            });
          }
        } catch (error: any) {
          console.error('Error finding event:', error);
          setError(error.message || 'Failed to find event. Please try again.');
        } finally {
          setProcessingStatus(null);
        }
      };
      
      lookupEvent();
    }
  }, [location.search]); // We don't need handleEventCodeSubmit in dependencies

  // Add the handleExistingEventData helper function
  const handleExistingEventData = async (existingData: any, event: any) => {
    setProcessingStatus('Found your previous photos for this event!');
    
    // Get the S3 bucket name
    const { bucketName } = await validateEnvVariables();
    
    // Add this event to the list if not already there
    const eventExists = attendedEvents.some(e => e.eventId === event.id);
    if (!eventExists) {
      const newEvent: Event = {
        eventId: event.id,
        eventName: existingData.eventName || event.name,
        eventDate: event.date,
        // Use coverImage from attendee data if available, then event's coverImage, then fall back to first matched image
        thumbnailUrl: existingData.coverImage || event.coverImage || existingData.matchedImages[0] || '',
        coverImage: existingData.coverImage || event.coverImage || ''
      };
      setAttendedEvents(prev => [newEvent, ...prev]);
    }
    
    // Add the matched images to the list if not already there
    const newImages: MatchingImage[] = existingData.matchedImages.map((url: string) => ({
      imageId: url.split('/').pop() || '',
      eventId: event.id,
      eventName: existingData.eventName || event.name,
      imageUrl: constructS3Url(url, bucketName),
      matchedDate: existingData.uploadedAt,
      similarity: 0
    }));
    
    // Check if these images are already in the state
    const existingImageUrls = new Set(matchingImages.map(img => img.imageUrl));
    const uniqueNewImages = newImages.filter(img => !existingImageUrls.has(img.imageUrl));
    
            if (uniqueNewImages.length > 0) {
          setMatchingImages(prev => deduplicateImages([...uniqueNewImages, ...prev]));
        }
    
    // Set filter to show only this event's images
    setSelectedEventFilter(event.id);
    
    // Set success message
    setSuccessMessage(`Found ${existingData.matchedImages.length} photos from ${event.name}!`);
  };

  // Scroll to matched images section when success message is set
  useEffect(() => {
    if (successMessage && matchedImagesRef.current) {
      // Only scroll for photo-related success messages
      if (successMessage.includes('photos') || successMessage.includes('Found')) {
        matchedImagesRef.current.scrollIntoView({ behavior: 'smooth' });
        
        // Clear photo-related success messages after 5 seconds
        const timer = setTimeout(() => {
          setSuccessMessage(null);
        }, 5000);
        
        return () => clearTimeout(timer);
      }
    }
  }, [successMessage]);

  // Clear selfie update success message after 2 seconds
  useEffect(() => {
    if (successMessage === 'Your selfie has been updated successfully!') {
      const timer = setTimeout(() => {
        setSuccessMessage(null);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

  useEffect(() => {
    const fetchUserData = async () => {
      try {
        const userEmail = localStorage.getItem('userEmail');
        setLoading(true);

        // Get the S3 bucket name
        const { bucketName } = await validateEnvVariables();

        // Dynamically import required modules
        const { getAllAttendeeImagesByUser, getAttendeeStatistics } = await import('../config/attendeeStorage');
        const { getEventById } = await import('../config/eventStorage');
            
        // If user is signed in, fetch their data
        if (userEmail) {
          // Fetch attendee image data from the database
          const attendeeImageData = await getAllAttendeeImagesByUser(userEmail);
          
          // Get statistics
          const userStats = await getAttendeeStatistics(userEmail);
          setStatistics(userStats);
          
          if (attendeeImageData.length > 0) {
            // Extract events from the attendee image data
            const eventsList: Event[] = [];
            const imagesList: MatchingImage[] = [];
            
            // Process each attendee-event entry sequentially to get event details
            for (const data of attendeeImageData) {
              // Get event details from the events database
              const eventDetails = await getEventById(data.eventId);
              
              // Skip the 'default' event entries
              if (data.eventId === 'default') continue;
              
              // Default event name and date if details not found
              const eventName = data.eventName || eventDetails?.name || `Event ${data.eventId}`;
              const eventDate = eventDetails?.date || data.uploadedAt;
              
              // Add to events list if not already added
              if (!eventsList.some(e => e.eventId === data.eventId)) {
                eventsList.push({
                  eventId: data.eventId,
                  eventName: eventName,
                  eventDate: eventDate,
                  // Use coverImage from attendee data if available, then event's coverImage, then fall back to first matched image
                  thumbnailUrl: data.coverImage || eventDetails?.coverImage || data.matchedImages[0] || '',
                  coverImage: data.coverImage || eventDetails?.coverImage || ''
                });
              }
              
              // Add all matched images to the images list
              data.matchedImages.forEach(imageUrl => {
                imagesList.push({
                  imageId: imageUrl.split('/').pop() || '',
                  eventId: data.eventId,
                  eventName: eventName,
                  imageUrl: constructS3Url(imageUrl, bucketName),
                  matchedDate: data.uploadedAt,
                  similarity: 0
                });
              });
            }
            
            // Update state - filter out any default entries and deduplicate
            setAttendedEvents(eventsList.filter(event => event.eventId !== 'default'));
            const filteredImagesList = imagesList.filter(image => image.eventId !== 'default');
            const deduplicatedImages = deduplicateImages(filteredImagesList);
            setMatchingImages(deduplicatedImages);
            setFilteredImages(deduplicatedImages); // Initially show all images
            
            // Set selfie URL to the most recent selfie
            const mostRecent = attendeeImageData.reduce((prev, current) => 
              new Date(current.uploadedAt) > new Date(prev.uploadedAt) ? current : prev
            );
            setSelfieUrl(mostRecent.selfieURL);
          } else {
            // No attendee image data found
          }
        } else {
          // User is not signed in, show empty state with event code entry
          setAttendedEvents([]);
          setMatchingImages([]);
          setFilteredImages([]);
          setStatistics({
            totalEvents: 0,
            totalImages: 0,
            firstEventDate: null,
            latestEventDate: null
          });
        }
        
        setLoading(false);
      } catch (error) {
        console.error('Error fetching user data:', error);
        setLoading(false);
      }
    };

    fetchUserData();
  }, [navigate]);

  // Filter images by event
  useEffect(() => {
    if (selectedEventFilter === 'all') {
      setFilteredImages(matchingImages);
    } else {
      const filtered = matchingImages.filter(image => image.eventId === selectedEventFilter);
      setFilteredImages(filtered);
    }
  }, [selectedEventFilter, matchingImages]);

  // Handle event filter change
  const handleEventFilterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedEventFilter(e.target.value);
  };

  // Handle event code form submission
  // Helper function to extract event ID from URL
  const extractEventIdFromUrl = (input: string): string | null => {
    try {
      // Check if input is a URL
      if (input.includes('http') || input.includes('chitralai.in')) {
        const url = new URL(input.startsWith('http') ? input : `https://${input}`);
        
        // Extract eventId from query parameters
        const eventId = url.searchParams.get('eventId');
        if (eventId) {
          return eventId;
        }
        
        // Also check for eventId in path segments (fallback)
        const pathSegments = url.pathname.split('/');
        const eventIdIndex = pathSegments.findIndex(segment => segment === 'attendee-dashboard');
        if (eventIdIndex !== -1 && pathSegments[eventIdIndex + 1]) {
          return pathSegments[eventIdIndex + 1];
        }
      }
      
      return null;
    } catch (error) {
      console.log('Not a valid URL, treating as event code');
      return null;
    }
  };

  const handleEventCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setEventDetails(null);
    setSuccessMessage(null);
    
    if (!eventCode.trim()) {
      setError('Please enter an event code or URL');
      return;
    }
    
    try {
      setProcessingStatus('Looking up event...');
      console.log('Looking up event with code:', eventCode);
      
      // Get user email if available
      const userEmail = localStorage.getItem('userEmail');
      
      // First, try to extract event ID from URL if input looks like a URL
      let eventIdToUse = eventCode.trim();
      const extractedEventId = extractEventIdFromUrl(eventCode.trim());
      
      if (extractedEventId) {
        console.log('Extracted event ID from URL:', extractedEventId);
        eventIdToUse = extractedEventId;
      }
      
      // Try to get event by ID first
      let event = await getEventById(eventIdToUse);
      console.log('Event lookup result:', event);
      
      // If not found, try some alternative approaches
      if (!event) {
        console.log('Event not found with exact ID, trying alternative methods...');
        
        // Try with leading zeros if needed (for 6-digit codes)
        if (eventIdToUse.length < 6) {
          const paddedCode = eventIdToUse.padStart(6, '0');
          console.log('Trying with padded code:', paddedCode);
          event = await getEventById(paddedCode);
        }
        
        // If it's exactly 6 digits, try without leading zeros
        if (eventIdToUse.length === 6 && eventIdToUse.startsWith('0')) {
          const unPaddedCode = eventIdToUse.replace(/^0+/, '');
          if (unPaddedCode) {
            console.log('Trying without leading zeros:', unPaddedCode);
            event = await getEventById(unPaddedCode);
          }
        }
      }
      
      if (!event) {
        throw new Error(`Event with code "${eventIdToUse}" not found. Please check the code or URL and try again. The code should be the unique identifier provided by the event organizer.`);
      }
      
      console.log('Event found:', event);
      
      // If user is not signed in, show event details and prompt to sign in
      if (!userEmail) {
        setEventDetails({
          id: event.id,
          name: event.name,
          date: event.date
        });
        setProcessingStatus(null);
        setError('Please sign in to access your photos from this event.');
        // Store complete URL for redirect after sign in
        localStorage.setItem('pendingAction', 'getPhotos');
        localStorage.setItem('pendingRedirectUrl', window.location.href);
        // Show sign in modal
        setShowSignInModal(true);
        return;
      }
      
      // Check if user already has images for this event
      const { getAttendeeImagesByUserAndEvent } = await import('../config/attendeeStorage');
      const existingData = await getAttendeeImagesByUserAndEvent(userEmail, event.id);
      
      if (existingData) {
        console.log('User already has images for this event:', existingData);
        await handleExistingEventData(existingData, event);
        
        // Clear event code
        setEventCode('');
        
        // Update statistics
        await updateStatistics();
        
        // Hide processing status after a delay
        setTimeout(() => setProcessingStatus(null), 3000);
      } else {
        // Check if user has an existing selfie
        if (selfieUrl) {
          // User has an existing selfie, use it for comparison automatically
          setProcessingStatus('Using your existing selfie to find photos...');
          
          // Start the face comparison process using the existing selfie
          await performFaceComparisonWithExistingSelfie(userEmail, selfieUrl, event);
          
          // Clear event code
          setEventCode('');
        } else {
          // No existing data or selfie, show the event details and selfie upload form
          setEventDetails({
            id: event.id,
            name: event.name,
            date: event.date
          });
          setProcessingStatus(null);
        }
      }
    } catch (error: any) {
      console.error('Error finding event:', error);
      setError(error.message || 'Failed to find event. Please try again.');
      setProcessingStatus(null);
    }
  };

  // Add a new function to update statistics
  const updateStatistics = async () => {
    try {
      const userEmail = localStorage.getItem('userEmail');
      if (userEmail) {
        const { getAttendeeStatistics } = await import('../config/attendeeStorage');
        const userStats = await getAttendeeStatistics(userEmail);
        setStatistics(userStats);
      }
    } catch (error) {
      console.error('Error updating statistics:', error);
    }
  };

  // Add the sanitizeFilename utility function
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

  // New function to upload the selfie
  const uploadSelfie = async (file: File) => {
    setError(null);
    setSuccessMessage(null);
    setProcessingStatus('Updating your selfie...');
    const { bucketName } = await validateEnvVariables();

    try {
      const userEmail = localStorage.getItem('userEmail') || '';
      
      // Generate a unique filename and sanitize it
      const timestamp = Date.now();
      const sanitizedFilename = sanitizeFilename(file.name);
      const fileName = `selfie-${timestamp}-${sanitizedFilename}`;
      const selfiePath = `users/${userEmail}/selfies/${fileName}`;
      
      // Convert File to arrayBuffer and then to Uint8Array
      const buffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      
      // Upload selfie to S3
      const upload = new Upload({
        client: await s3ClientPromise,
        params: {
          Bucket: bucketName,
          Key: selfiePath,
          Body: uint8Array,
          ContentType: file.type,
          ACL: 'public-read'
        },
        partSize: 1024 * 1024 * 5
      });
      
      await upload.done();
      
      // Get the public URL of the uploaded selfie
      const selfieUrl = `https://${bucketName}.s3.amazonaws.com/${selfiePath}`;
      
      // Import the necessary functions
      const { updateUserSelfieURL, getAllAttendeeImagesByUser } = await import('../config/attendeeStorage');
      
      // Check if the user has any events
      const userEvents = await getAllAttendeeImagesByUser(userEmail);
      
      // If the user has events, update the selfie URL for all of them
      if (userEvents.length > 0) {
        const updateResult = await updateUserSelfieURL(userEmail, selfieUrl);
        
        if (!updateResult) {
          console.warn('Failed to update selfie for existing events');
        }
      }
      
      // Update the selfie URL in state
      setSelfieUrl(selfieUrl);
      setSelfie(file);
      
      // Update statistics after selfie update
      await updateStatistics();
      
      // Show success message
      setProcessingStatus(null);
      setSuccessMessage('Your selfie has been updated successfully!');
      
      // If event code is present, automatically trigger handleEventCodeSubmit
      if (eventCode && eventDetails) {
        // Start the face comparison process
        setProcessingStatus('Finding your photos...');
        try {
          await performFaceComparisonWithExistingSelfie(userEmail, selfieUrl, eventDetails);
        } catch (error: any) {
          console.error('Error in face comparison:', error);
          setError(error.message || 'Error finding your photos. Please try again.');
        }
      }
      
      // Scroll to top to show the updated selfie
      window.scrollTo({ top: 0, behavior: 'smooth' });
      
    } catch (error: any) {
      console.error('Error updating selfie:', error);
      setError(error.message || 'Error updating your selfie. Please try again.');
      setProcessingStatus(null);
    }
  };

  // New function to perform face comparison with existing selfie
  const performFaceComparisonWithExistingSelfie = async (userEmail: string, existingSelfieUrl: string, event: any) => {
    try {
      setIsUploading(true);
      setProcessingStatus('Comparing with event images...');
      
      // Extract the S3 key from the selfie URL
      const { bucketName } = await validateEnvVariables();
      let selfiePath = '';
      
      if (existingSelfieUrl.startsWith(`https://${bucketName}.s3.amazonaws.com/`)) {
        selfiePath = existingSelfieUrl.substring(`https://${bucketName}.s3.amazonaws.com/`.length);
      } else {
        throw new Error('Could not determine S3 path for the existing selfie');
      }
      
      // Search for matching faces in the event collection
      const matches = await searchFacesByImage(event.id, selfiePath);

      if (matches.length === 0) {
        throw new Error('No matching faces found in the event images.');
      }

      // Convert matches to MatchingImage format
      const matchingImages: MatchingImage[] = matches
        .filter(match => match.similarity >= 70) // Only include high confidence matches
        .map(match => {
          // Get the filename from the match
          const filename = match.imageKey.split('/').pop() || '';
          // Construct the full S3 URL
          const imageUrl = `https://${bucketName}.s3.amazonaws.com/events/shared/${event.id}/images/${filename}`;
          
          return {
            imageId: filename,
            eventId: event.id,
            eventName: event.name,
            imageUrl: imageUrl,
            matchedDate: new Date().toISOString(),
            similarity: match.similarity
          };
        });
      
      // Add this event to attended events if not already there
      const eventExists = attendedEvents.some(e => e.eventId === event.id);
      
      if (!eventExists) {
        const newEvent: Event = {
          eventId: event.id,
          eventName: event.name,
          eventDate: event.date,
          thumbnailUrl: event.coverImage || matchingImages[0]?.imageUrl || '',
          coverImage: event.coverImage || ''
        };
        
        setAttendedEvents(prev => [newEvent, ...prev]);
      }
      
      // Store the attendee image data in the database
      const matchedImageUrls = matchingImages.map(match => match.imageUrl);
      const currentTimestamp = new Date().toISOString();
      
      const attendeeData = {
        userId: userEmail,
        eventId: event.id,
        eventName: event.name,
        coverImage: event.coverImage,
        selfieURL: existingSelfieUrl,
        matchedImages: matchedImageUrls,
        uploadedAt: currentTimestamp,
        lastUpdated: currentTimestamp
      };
      
      // Store in the database
      const storageResult = await storeAttendeeImageData(attendeeData);
      
      if (!storageResult) {
        console.error('Failed to store attendee image data in the database');
      }
      
      // Update statistics
      await updateStatistics();
      
      // Merge with existing images and deduplicate
      const allImages = [...matchingImages, ...filteredImages];
      const deduplicatedImages = deduplicateImages(allImages);
      
      // Set success message and filter to show only this event's images
      setSuccessMessage(`Found ${matchingImages.length} new photos from ${event.name}!`);
      setSelectedEventFilter(event.id);
      setMatchingImages(deduplicatedImages);
      
      // Clear event code and details since we're done processing
      setEventCode('');
      setEventDetails(null);
      
      setProcessingStatus(null);
      setIsUploading(false);
      
    } catch (error: any) {
      console.error('Error in comparison with existing selfie:', error);
      setError(error.message || 'Error processing your request. Please try again.');
      setIsUploading(false);
      setProcessingStatus(null);
    }
  };

  // Camera control functions
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      setStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (error) {
      console.error('Error accessing camera:', error);
      setError('Could not access camera. Please make sure you have granted camera permissions.');
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const captureImage = async () => {
    if (!videoRef.current) return;

    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(videoRef.current, 0, 0);
    canvas.toBlob(async (blob) => {
      if (blob) {
        const file = new File([blob], 'selfie.jpg', { type: 'image/jpeg' });
        setSelfie(file);
        stopCamera();
        setShowCameraModal(false); // Close the camera modal
        setIsCameraActive(false);

        try {
          // Upload the selfie and update database
          await uploadSelfie(file);
        } catch (error: any) {
          console.error('Error uploading selfie:', error);
          setError(error.message || 'Failed to upload selfie. Please try again.');
        }
      }
    }, 'image/jpeg');
  };

  const clearSelfie = () => {
    setSelfieImage(null);
  };

  const handleUpdateSelfie = () => {
    clearSelfie();
    setShowCameraModal(true); // Open the camera modal first
    setIsCameraActive(true); // Set camera as active
    startCamera(); // Then start the camera
  };

  // Upload selfie and compare faces
  const handleUploadAndCompare = async () => {
    if (!selectedEvent) {
      alert('Please select an event first.');
      return;
    }

    if (!selfieImage) {
      alert('Please take or upload a selfie first.');
      return;
    }
    
    setIsLoading(true);
    setMatchingImages([]);
    setError(null);

    try {
      // Upload selfie to S3
      const selfieKey = `events/shared/${selectedEvent}/selfies/${Date.now()}-${selfieImage.name}`;
      const selfieUrl = await uploadSelfie(selfieImage);

      // Search for matching faces in the event collection
      const matches = await searchFacesByImage(selectedEvent, selfieKey);

      if (matches.length === 0) {
        setError('No matching photos found. Please try again with a different selfie.');
        return;
      }

      // Get the event details
      const event = await getEventById(selectedEvent);
      if (!event) {
        throw new Error('Event not found');
      }

      // Convert matches to MatchingImage format
      const matchingImages: MatchingImage[] = matches
        .filter(match => match.similarity >= 70) // Only include high confidence matches
        .map(match => ({
          imageId: match.imageKey,
          eventId: selectedEvent,
          eventName: event.name,
          imageUrl: `https://${process.env.REACT_APP_AWS_S3_BUCKET}.s3.amazonaws.com/${match.imageKey}`,
          matchedDate: new Date().toISOString(),
          similarity: match.similarity
        }));

        setMatchingImages(matchingImages);
      setShowResults(true);
    } catch (error) {
      console.error('Error finding matching photos:', error);
      setError('An error occurred while finding matching photos. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle event click to view associated images
  const handleEventClick = (eventId: string) => {
    // Skip navigation for default event
    if (eventId === 'default') return;
    
    // Navigate to the event photos page
    navigate(`/event-photos/${eventId}`);
  };

  // QR Code Scanner handlers
  const handleQRScan = (result: string) => {
    console.log('QR Code scanned:', result);
    setEventCode(result);
    // Automatically submit the form with the scanned result
    const formEvent = { preventDefault: () => {} } as React.FormEvent;
    handleEventCodeSubmit(formEvent);
  };

  const handleOpenQRScanner = () => {
    setShowQRScanner(true);
  };

  const handleCloseQRScanner = () => {
    setShowQRScanner(false);
  };

  const handleDownload = async (url: string) => {
    try {
// Get user email and use it for download tracking
const userEmail = localStorage.getItem('userEmail') || '';
console.log(`User ${userEmail} downloading image`);
      const response = await fetch(url, {
        headers: {
          'Cache-Control': 'no-cache',
        },
        mode: 'cors',
      });
      
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.statusText}`);
      }
      
      // Get the content type
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      
      // Get the image as a blob
      const blob = await response.blob();
      
      // Create a blob URL
      const blobUrl = window.URL.createObjectURL(blob);
      
      // Extract filename from URL
      const filename = url.split('/').pop() || 'photo.jpg';
      
      // Create a temporary anchor element
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      link.type = contentType;
      link.target = '_blank';
      
      // Required for Firefox
      document.body.appendChild(link);
      
      // Trigger the download
      link.click();
      
      // Cleanup
      setTimeout(() => {
        document.body.removeChild(link);
        window.URL.revokeObjectURL(blobUrl);
      }, 100);
    } catch (error) {
      console.error('Error downloading image:', error);
      // If download fails, open the image in a new tab
      window.open(url, '_blank');
    }
  };

  const handleDownloadAll = async () => {
    try {
      // Show a message that downloads are starting
      alert('Starting downloads. Please allow multiple downloads in your browser settings.');
      
      // Download each image with a small delay to prevent browser blocking
      for (const image of filteredImages) {
        await handleDownload(image.imageUrl);
        // Add a small delay between downloads
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error('Error downloading all images:', error);
      alert('Some downloads may have failed. Please try downloading individual photos.');
    }
  };

  // Add styles for animation
  const fadeInOutStyles = `
    @keyframes fadeInOut {
      0% { opacity: 0; transform: translateY(-20px); }
      15% { opacity: 1; transform: translateY(0); }
      85% { opacity: 1; transform: translateY(0); }
      100% { opacity: 0; transform: translateY(-20px); }
    }
    .animate-fade-in-out {
      animation: fadeInOut 2s ease-in-out forwards;
    }
  `;

  // Add this CSS at the top of the component, after the fadeInOutStyles
  const scrollbarStyles = `
    .custom-scrollbar::-webkit-scrollbar {
      width: 8px;
    }
    
    .custom-scrollbar::-webkit-scrollbar-track {
      background: #f1f1f1;
      border-radius: 4px;
    }
    
    .custom-scrollbar::-webkit-scrollbar-thumb {
      background: #888;
      border-radius: 4px;
    }
    
    .custom-scrollbar::-webkit-scrollbar-thumb:hover {
      background: #555;
    }
  `;

  // New function to handle sharing image
  const handleShare = async (platform: string, imageUrl: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
    }

    try {
      // Fetch the image and convert to blob
      const response = await fetch(imageUrl, {
        headers: {
          'Cache-Control': 'no-cache',
        },
        mode: 'cors',
      });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }
      
      const blob = await response.blob();
      const imageFile = new File([blob], 'photo.jpg', { type: blob.type });

      // If Web Share API is supported and platform is not specified (direct share button click)
      if (typeof navigator.share === 'function' && !platform) {
        try {
          await navigator.share({
            title: 'Check out this photo!',
            text: 'Photo from Chitralai',
            files: [imageFile]
          });
          setShareMenu(prev => ({ ...prev, isOpen: false }));
          return;
        } catch (err) {
          if (err instanceof Error && err.name !== 'AbortError') {
            console.error('Error sharing file:', err);
          }
        }
      }

      // Fallback to custom share menu for specific platforms
      const shareUrl = encodeURIComponent(imageUrl);
      const shareText = encodeURIComponent('Check out this photo!');
      
      let shareLink = '';
      switch (platform) {
        case 'facebook':
          shareLink = `https://www.facebook.com/sharer/sharer.php?u=${shareUrl}`;
          break;
        case 'twitter':
          shareLink = `https://twitter.com/intent/tweet?url=${shareUrl}&text=${shareText}`;
          break;
        case 'instagram':
          shareLink = `instagram://library?AssetPath=${shareUrl}`;
          break;
        case 'linkedin':
          shareLink = `https://www.linkedin.com/sharing/share-offsite/?url=${shareUrl}`;
          break;
        case 'whatsapp':
          shareLink = `https://api.whatsapp.com/send?text=${shareText}%20${shareUrl}`;
          break;
        case 'email':
          shareLink = `mailto:?subject=${shareText}&body=${shareUrl}`;
          break;
        case 'copy':
          try {
            await navigator.clipboard.writeText(imageUrl);
            alert('Link copied to clipboard!');
            setShareMenu(prev => ({ ...prev, isOpen: false }));
            return;
          } catch (err) {
            console.error('Failed to copy link:', err);
            alert('Failed to copy link');
          }
          break;
      }
      
      if (shareLink) {
        window.open(shareLink, '_blank', 'noopener,noreferrer');
        setShareMenu(prev => ({ ...prev, isOpen: false }));
      }
    } catch (error) {
      console.error('Error sharing image:', error);
      alert('Failed to share image. Please try again.');
    }
  };

  // Close share menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (shareMenu.isOpen) {
        const target = event.target as HTMLElement;
        if (!target.closest('.share-menu')) {
          setShareMenu(prev => ({ ...prev, isOpen: false }));
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [shareMenu.isOpen]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
            <p className="mt-4 text-gray-600">Loading your dashboard...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pt-20 pb-6 px-4 sm:px-6 lg:px-8">
      <style>{fadeInOutStyles}</style>
      <style>{scrollbarStyles}</style>
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Your Event Memories</h1>
          <p className="mt-2 text-black-600">Find and view your photos from events</p>
        </div>

        {/* Top Row containing Event Form, Stats and Selfie */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6 mb-8">
          {/* Event Code Entry Section */}
          <div className="bg-white rounded-lg shadow-sm p-4 sm:p-6 h-full">
            <h2 className="text-lg sm:text-xl font-semibold text-gray-900 mb-3 sm:mb-4">Enter Event Code, URL, or Scan QR</h2>
            <p className="text-sm text-gray-600 mb-3 sm:mb-4">
              Find your photos from events. You can enter an event code, paste a URL, or scan a QR code.
            </p>
            
            {error && (
              <div className="bg-red-50 text-red-600 p-2 rounded-lg mb-3 text-sm">
                {error}
              </div>
            )}
            
            {processingStatus && (
              <div className="bg-blue-50 text-blue-600 p-2 rounded-lg mb-3 text-sm flex items-center">
                <div className="animate-spin rounded-full h-3 w-3 border-t-2 border-b-2 border-blue-600 mr-2"></div>
                {processingStatus}
              </div>
            )}
            
            <form onSubmit={handleEventCodeSubmit}>
              <div className="flex space-x-2">
                <input
                  type="text"
                  value={eventCode}
                  onChange={(e) => setEventCode(e.target.value)}
                  placeholder="Event code or URL"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm sm:text-base"
                  required
                />
                <button
                  type="button"
                  onClick={handleOpenQRScanner}
                  className="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center justify-center text-sm sm:text-base"
                  title="Scan QR Code"
                >
                  <QrCode className="w-4 h-4" />
                </button>
                <button
                  type="submit"
                  className="px-3 sm:px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center text-sm sm:text-base whitespace-nowrap"
                  disabled={isUploading}
                >
                  <Search className="w-4 h-4 mr-1" />
                  Find
                </button>
              </div>
            </form>
            
            {!selfieUrl && eventDetails && (
              <div className="border border-blue-200 bg-blue-50 p-3 rounded-lg mt-4">
                <h3 className="font-semibold text-blue-800 text-sm">{eventDetails.name}</h3>
                <p className="text-blue-600 text-xs">
                  {new Date(eventDetails.date).toLocaleDateString()}
                </p>
                
                <div className="mt-3">
                  <p className="text-gray-700 text-sm mb-2">
                    Upload a selfie to find your photos
                  </p>
                  {selfiePreview ? (
                    <div className="relative w-20 h-20 mb-2">
                      <img
                        src={selfiePreview}
                        alt="Selfie preview"
                        className="w-full h-full object-cover rounded-lg"
                      />
                      <button
                        onClick={clearSelfie}
                        className="absolute -top-1 -right-1 bg-blue-500 text-white rounded-full p-1 hover:bg-blue-600 transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={handleUpdateSelfie}
                      className="cursor-pointer bg-blue-100 text-blue-800 px-3 py-1.5 rounded-lg hover:bg-blue-200 transition-colors inline-block text-sm"
                    >
                      <Camera className="w-3 h-3 inline-block mr-1" />
                      Select Selfie
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Quick Stats Section */}
          <div className="bg-white rounded-lg shadow-sm p-4 sm:p-6 h-full">
            <h2 className="text-lg sm:text-xl font-semibold text-gray-900 mb-3 sm:mb-4">Your Photo Stats</h2>
            <div className="bg-blue-50 rounded-lg p-3 sm:p-4 flex flex-row sm:flex-col items-center justify-between gap-2 sm:gap-4">
              <div className="flex items-center gap-2">
                <Calendar className="h-5 w-5 text-blue-600" />
                <span className="text-gray-700">Events</span>
                <span className="text-lg sm:text-xl font-bold text-blue-600">{statistics.totalEvents}</span>
              </div>
              <div className="h-8 w-px bg-blue-200 sm:hidden"></div>
              <div className="w-full h-px bg-blue-200 hidden sm:block my-1"></div>
              <div className="flex items-center gap-2">
                <ImageIcon className="h-5 w-5 text-blue-600" />
                <span className="text-gray-700">Photos</span>
                <span className="text-lg sm:text-xl font-bold text-blue-600">{statistics.totalImages}</span>
              </div>
            </div>
          </div>

          {/* Selfie Section */}
          <div className="bg-white rounded-lg shadow-sm p-4 sm:p-6 h-full flex flex-col sm:col-span-2 lg:col-span-1">
            <h2 className="text-lg sm:text-xl font-semibold text-gray-900 mb-3 sm:mb-4">Your Selfie</h2>
            <div className="flex flex-col items-center flex-grow justify-center">
              <div className="h-24 w-24 rounded-full overflow-hidden bg-gray-100 relative mb-3">
                {selfieUrl ? (
                  <img src={selfieUrl} alt="Your selfie" className="h-full w-full object-cover" />
                ) : (
                  <Camera className="h-full w-full text-gray-400 p-6" />
                )}
                {processingStatus && processingStatus.includes('Updating your selfie') && (
                  <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-white"></div>
                  </div>
                )}
              </div>
              <p className="text-xs sm:text-sm text-gray-600 text-center mb-3 sm:mb-5">Used for photo matching across events</p>
              <button
                onClick={handleUpdateSelfie}
                disabled={!!processingStatus && processingStatus.includes('Updating your selfie')}
                className={`w-full sm:max-w-xs px-3 sm:px-4 py-2 rounded-lg ${
                  processingStatus && processingStatus.includes('Updating your selfie')
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                } transition-colors flex items-center justify-center mt-auto`}
              >
                {processingStatus && processingStatus.includes('Updating your selfie') ? (
                  <>
                    <div className="animate-spin rounded-full h-3 sm:h-4 w-3 sm:w-4 border-t-2 border-b-2 border-white mr-1 sm:mr-2"></div>
                    Updating...
                  </>
                ) : (
                  <>
                    <Camera className="w-3 sm:w-4 h-3 sm:h-4 mr-1 sm:mr-2" />
                    Update Selfie
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Matching Images Section */}
        <div ref={matchedImagesRef} className="bg-white rounded-lg shadow-sm p-4 sm:p-6 mb-8">
          <div className="mb-4 sm:mb-6">
            <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-2">
              {selectedEventFilter !== 'all' 
                ? `Photos from ${attendedEvents.find(e => e.eventId === selectedEventFilter)?.eventName || 'Event'}`
                : 'All Your Photos'
              }
            </h2>
            {selectedEventFilter !== 'all' && (
              <p className="text-gray-600 text-sm mt-1">
                {attendedEvents.find(e => e.eventId === selectedEventFilter)?.eventDate 
                  ? `Event date: ${new Date(attendedEvents.find(e => e.eventId === selectedEventFilter)?.eventDate || '').toLocaleDateString()}`
                  : ''
                }
              </p>
            )}
          </div>
          
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            {filteredImages.length > 0 && (
              <button
                onClick={handleDownloadAll}
                className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                <Download className="h-4 w-4 mr-2" />
                Download All
              </button>
            )}
            
            <div className="flex items-center gap-2 flex-wrap">
              <label htmlFor="event-filter" className="text-gray-700 whitespace-nowrap">Filter by event:</label>
              <select
                id="event-filter"
                value={selectedEventFilter}
                onChange={handleEventFilterChange}
                className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-full sm:w-auto max-w-[230px]"
              >
                <option value="all">All Events</option>
                {attendedEvents
                  .filter(event => event.eventId !== 'default')
                  .map(event => (
                    <option key={event.eventId} value={event.eventId}>
                      {event.eventName}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          
          {filteredImages.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3 sm:gap-4 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
              {filteredImages.map((image, idx) => {
                // Create a unique key using the image URL and index to handle duplicates
                const uniqueKey = `${image.eventId || 'noevent'}-${image.imageUrl}-${idx}`;
                return (
                  <div
                    key={uniqueKey}
                    className="relative group aspect-square cursor-pointer"
                    onClick={() => {
                      setSelectedImage(image);
                      toggleHeaderFooter(false);
                    }}
                  >
                    <div className="absolute inset-0 rounded-lg overflow-hidden">
                      <img
                        src={image.imageUrl}
                        alt={`Photo from ${image.eventName}`}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all duration-200 rounded-lg flex items-center justify-center">
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex space-x-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDownload(image.imageUrl);
                          }}
                          className="p-2 rounded-full bg-white/20 text-white hover:bg-white/40 transition-colors duration-200"
                        >
                          <Download className="w-5 h-5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            // Try native sharing first
                            if (typeof navigator.share === 'function') {
                              handleShare('', image.imageUrl, e);
                            } else {
                              // Fall back to custom share menu
                              const rect = e.currentTarget.getBoundingClientRect();
                              setShareMenu({
                                isOpen: true,
                                imageUrl: image.imageUrl,
                                position: {
                                  top: rect.top - 200,
                                  left: rect.left - 200
                                }
                              });
                            }
                          }}
                          className="p-2 rounded-full bg-white/20 text-white hover:bg-white/40 transition-colors duration-200"
                        >
                          <Share2 className="w-5 h-5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-10">
              <ImageIcon className="h-12 w-12 text-gray-400 mx-auto" />
              {selectedEventFilter !== 'all' ? (
                <>
                  <p className="mt-2 text-gray-500">No photos found for this event</p>
                  <button
                    onClick={() => setSelectedEventFilter('all')}
                    className="mt-4 text-blue-600 hover:text-blue-800 px-4 py-2 border border-blue-300 rounded-lg"
                  >
                    Show all photos
                  </button>
                </>
              ) : (
                <>
                  <p className="mt-2 text-gray-500">No matching photos found for any events</p>
                  <p className="mt-2 text-sm text-gray-500">Enter an event code above to find your photos</p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Attended Events Section */}
        <div className="bg-white rounded-lg shadow-sm p-4 sm:p-6 mb-8">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg sm:text-xl font-semibold text-gray-900">Your Event Albums</h2>
            <select
              value={eventSortOption}
              onChange={(e) => setEventSortOption(e.target.value as 'date' | 'name')}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="date">Latest First</option>
              <option value="name">Name A-Z</option>
            </select>
          </div>

          {attendedEvents.length === 0 ? (
            <div className="bg-gray-50 rounded-lg p-4 sm:p-6 text-center">
              <Calendar className="h-10 sm:h-12 w-10 sm:w-12 text-gray-400 mx-auto mb-2" />
              <p className="text-gray-600">You haven't attended any events yet.</p>
              <p className="text-gray-500 text-sm mt-2">Enter an event code above to find your photos from an event.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3 sm:gap-4 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
              {attendedEvents
                .filter(event => event.eventId !== 'default')
                .sort((a, b) => {
                  if (eventSortOption === 'date') {
                    return new Date(b.eventDate).getTime() - new Date(a.eventDate).getTime();
                  } else {
                    return a.eventName.localeCompare(b.eventName);
                  }
                })
                .map((event) => (
                  <div
                    key={event.eventId}
                    className="bg-white rounded-lg shadow-sm overflow-hidden hover:shadow-md transition-shadow border border-gray-200 cursor-pointer"
                    onClick={() => handleEventClick(event.eventId)}
                  >
                    <div className="aspect-square relative">
                      <img
                        src={event.thumbnailUrl || event.coverImage}
                        alt={`${event.eventName} thumbnail`}
                        className="object-cover w-full h-full"
                      />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3">
                        <h3 className="text-white font-semibold truncate">{event.eventName}</h3>
                        <p className="text-white/80 text-sm">
                          {new Date(event.eventDate).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
      
      {/* Enlarged Image Modal */}
      {selectedImage && (
        <div 
          className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4" 
          onClick={() => {
            setSelectedImage(null);
            toggleHeaderFooter(true);
          }}
        >
          <div className="relative bg-white rounded-lg shadow-xl max-w-[800px] max-h-[600px] w-full mx-auto" onClick={e => e.stopPropagation()}>
            <img
              src={selectedImage.imageUrl}
              alt={`Enlarged photo from ${selectedImage.eventName}`}
              className="w-full h-full object-contain rounded-lg"
              style={{ maxHeight: 'calc(600px - 4rem)' }}
            />
            <button
              className="absolute top-4 right-4 p-2 rounded-full bg-black/20 text-white hover:bg-black/70 transition-colors duration-200"
              onClick={() => {
                setSelectedImage(null);
                toggleHeaderFooter(true);
              }}
            >
              <X className="w-8 h-8" />
            </button>
            <div className="absolute bottom-4 right-4 flex space-x-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  // Try native sharing first
                  if (typeof navigator.share === 'function') {
                    handleShare('', selectedImage.imageUrl, e);
                  } else {
                    // Fall back to custom share menu
                    setShareMenu({
                      isOpen: true,
                      imageUrl: selectedImage.imageUrl,
                      position: {
                        top: rect.top - 200,
                        left: rect.left - 200
                      }
                    });
                  }
                }}
                className="p-2 rounded-full bg-black/10 text-white hover:bg-black/70 transition-colors duration-200 flex items-center gap-2"
              >
                <Share2 className="w-6 h-6" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload(selectedImage.imageUrl);
                }}
                className="p-2 rounded-full bg-black/10 text-white hover:bg-black/70 transition-colors duration-200 flex items-center gap-2"
              >
                <Download className="w-6 h-6" />
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Camera Modal */}
      {showCameraModal && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-md w-full relative">
            <button
              onClick={() => {
                stopCamera();
                setShowCameraModal(false);
              }}
              className="absolute -top-3 -right-3 bg-white text-gray-700 rounded-full p-2 shadow-lg hover:bg-gray-100"
            >
              <X className="w-5 h-5" />
            </button>
            
            <h3 className="text-xl font-semibold text-gray-900 mb-4">Take a Selfie</h3>
            
            {error && (
              <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg">
                {error}
              </div>
            )}
            
            <div className="relative w-full">
              {isCameraActive && (
                <div className="mb-4">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    className="w-full rounded-lg border-2 border-blue-500"
                    style={{ transform: 'scaleX(-1)' }} // Mirror the video feed
                  />
                  
                  <button
                    onClick={captureImage}
                    className="mt-4 w-full py-2 px-4 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center"
                  >
                    <Camera className="w-5 h-5 mr-2" />
                    Capture Selfie
                  </button>
                </div>
              )}
              
              {!isCameraActive && processingStatus && (
                <div className="flex items-center justify-center p-6">
                  <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-600 mr-3"></div>
                  <p className="text-blue-600">{processingStatus}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Success Message Popup */}
      {successMessage && successMessage === 'Your selfie has been updated successfully!' && (
        <div className="fixed left-0 right-0 top-16 sm:top-24 z-[3000] pointer-events-none">
          <div className="container mx-auto px-4 max-w-md">
            <div className="bg-green-50 text-green-700 p-4 rounded-lg shadow-lg flex items-center gap-3 animate-fade-in-out">
              <div className="bg-green-100 rounded-full p-1.5 flex-shrink-0">
                <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <span className="text-sm font-medium">{successMessage}</span>
            </div>
          </div>
        </div>
      )}

      {/* Share Menu */}
      {shareMenu.isOpen && (
        <div
          className="share-menu fixed z-50 bg-white rounded-lg shadow-xl p-4 w-64"
          style={{
            top: `${shareMenu.position.top}px`,
            left: `${shareMenu.position.left}px`,
          }}
        >
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={(e) => handleShare('facebook', shareMenu.imageUrl, e)}
              className="flex flex-col items-center justify-center p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Facebook className="h-6 w-6 text-blue-600" />
            </button>
            <button
              onClick={(e) => handleShare('instagram', shareMenu.imageUrl, e)}
              className="flex flex-col items-center justify-center p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Instagram className="h-6 w-6 text-pink-600" />
            </button>
            <button
              onClick={(e) => handleShare('twitter', shareMenu.imageUrl, e)}
              className="flex flex-col items-center justify-center p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Twitter className="h-6 w-6 text-blue-400" />
            </button>
            <button
              onClick={(e) => handleShare('linkedin', shareMenu.imageUrl, e)}
              className="flex flex-col items-center justify-center p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Linkedin className="h-6 w-6 text-blue-700" />
            </button>
            <button
              onClick={(e) => handleShare('whatsapp', shareMenu.imageUrl, e)}
              className="flex flex-col items-center justify-center p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <MessageCircle className="h-6 w-6 text-green-500" />
            </button>
            <button
              onClick={(e) => handleShare('email', shareMenu.imageUrl, e)}
              className="flex flex-col items-center justify-center p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Mail className="h-6 w-6 text-gray-600" />
            </button>
            <button
              onClick={(e) => handleShare('copy', shareMenu.imageUrl, e)}
              className="flex flex-col items-center justify-center p-2 hover:bg-gray-100 rounded-lg transition-colors col-start-2"
            >
              <Link className="h-6 w-6 text-gray-600" />
            </button>
          </div>
        </div>
      )}

      {/* QR Code Scanner Modal */}
      <QRCodeScanner
        isOpen={showQRScanner}
        onScan={handleQRScan}
        onClose={handleCloseQRScanner}
      />
    </div>
  );
};

export default AttendeeDashboard; 


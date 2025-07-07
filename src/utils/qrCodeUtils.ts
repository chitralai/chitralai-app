import QRCode from 'qrcode';

// Generate QR code for an event URL
export const generateEventQRCode = async (eventId: string): Promise<string> => {
  const eventUrl = `https://chitralai.in/attendee-dashboard?eventId=${eventId}`;
  try {
    const qrCodeDataUrl = await QRCode.toDataURL(eventUrl, {
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    return qrCodeDataUrl;
  } catch (error) {
    console.error('Error generating QR code:', error);
    throw error;
  }
};

// Generate QR code for a simple event code
export const generateEventCodeQRCode = async (eventCode: string): Promise<string> => {
  try {
    const qrCodeDataUrl = await QRCode.toDataURL(eventCode, {
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    return qrCodeDataUrl;
  } catch (error) {
    console.error('Error generating QR code:', error);
    throw error;
  }
};

// Test function to validate QR code content
export const validateQRCodeContent = (content: string): boolean => {
  // Check if it's a valid event URL
  if (content.includes('chitralai.in/attendee-dashboard')) {
    const url = new URL(content);
    return url.searchParams.has('eventId');
  }
  
  // Check if it's a valid event code (numeric)
  if (/^\d+$/.test(content)) {
    return true;
  }
  
  // Check if it's a URL that can be processed
  if (content.includes('http') || content.includes('chitralai.in')) {
    return true;
  }
  
  return false;
}; 
import React, { useState } from 'react';
import { generateEventQRCode, generateEventCodeQRCode } from '../utils/qrCodeUtils';

const QRCodeDemo: React.FC = () => {
  const [eventId, setEventId] = useState('195465');
  const [eventCode, setEventCode] = useState('195465');
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [qrCodeEventCode, setQrCodeEventCode] = useState<string>('');

  const generateEventQR = async () => {
    try {
      const qrCode = await generateEventQRCode(eventId);
      setQrCodeUrl(qrCode);
    } catch (error) {
      console.error('Error generating event QR code:', error);
    }
  };

  const generateEventCodeQR = async () => {
    try {
      const qrCode = await generateEventCodeQRCode(eventCode);
      setQrCodeEventCode(qrCode);
    } catch (error) {
      console.error('Error generating event code QR code:', error);
    }
  };

  return (
    <div className="p-6 bg-white rounded-lg shadow-sm">
      <h3 className="text-lg font-semibold mb-4">QR Code Demo</h3>
      
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Event ID for URL QR Code:
          </label>
          <div className="flex space-x-2">
            <input
              type="text"
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter event ID"
            />
            <button
              onClick={generateEventQR}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Generate URL QR
            </button>
          </div>
          {qrCodeUrl && (
            <div className="mt-4 text-center">
              <p className="text-sm text-gray-600 mb-2">QR Code for: https://chitralai.in/attendee-dashboard?eventId={eventId}</p>
              <img src={qrCodeUrl} alt="Event URL QR Code" className="mx-auto border rounded-lg" />
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Event Code for Simple QR Code:
          </label>
          <div className="flex space-x-2">
            <input
              type="text"
              value={eventCode}
              onChange={(e) => setEventCode(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter event code"
            />
            <button
              onClick={generateEventCodeQR}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
            >
              Generate Code QR
            </button>
          </div>
          {qrCodeEventCode && (
            <div className="mt-4 text-center">
              <p className="text-sm text-gray-600 mb-2">QR Code for event code: {eventCode}</p>
              <img src={qrCodeEventCode} alt="Event Code QR Code" className="mx-auto border rounded-lg" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default QRCodeDemo; 
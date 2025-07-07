import React, { useState, useRef, useEffect } from 'react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { X, Camera, QrCode } from 'lucide-react';

interface QRCodeScannerProps {
  onScan: (result: string) => void;
  onClose: () => void;
  isOpen: boolean;
}

const QRCodeScanner: React.FC<QRCodeScannerProps> = ({ onScan, onClose, isOpen }) => {
  const [scanner, setScanner] = useState<Html5QrcodeScanner | null>(null);
  const scannerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && scannerRef.current && !scanner) {
      const html5QrcodeScanner = new Html5QrcodeScanner(
        "qr-reader",
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
          aspectRatio: 1.0,
        },
        false
      );

      html5QrcodeScanner.render(
        (decodedText) => {
          console.log('QR Code detected:', decodedText);
          onScan(decodedText);
          html5QrcodeScanner.clear();
          onClose();
        },
        (error) => {
          // Handle scan error silently
          console.log('QR scan error:', error);
        }
      );

      setScanner(html5QrcodeScanner);
    }

    return () => {
      if (scanner) {
        scanner.clear();
        setScanner(null);
      }
    };
  }, [isOpen, scanner, onScan, onClose]);

  useEffect(() => {
    if (!isOpen && scanner) {
      scanner.clear();
      setScanner(null);
    }
  }, [isOpen, scanner]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center">
            <QrCode className="w-5 h-5 mr-2" />
            Scan QR Code
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
        
        <div className="p-4">
          <div id="qr-reader" ref={scannerRef}></div>
          
          <div className="mt-4 text-center">
            <p className="text-sm text-gray-600 mb-3">
              Point your camera at a QR code to scan
            </p>
            <div className="flex items-center justify-center text-xs text-gray-500">
              <Camera className="w-4 h-4 mr-1" />
              Camera access required
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default QRCodeScanner; 
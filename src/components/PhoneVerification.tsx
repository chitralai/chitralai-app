import React, { useState, useRef } from 'react';
import { Phone, Upload } from 'lucide-react';
import { GoogleLogin } from '@react-oauth/google';
import { Link } from 'react-router-dom';

interface PhoneVerificationProps {
  onSubmit: (data: {
    phoneNumber: string;
  }) => void;
  onGoogleSignIn: (response: any) => void;
  onError: () => void;
  isSignUp?: boolean;
}

const PhoneVerification: React.FC<PhoneVerificationProps> = ({ 
  onSubmit, 
  onGoogleSignIn, 
  onError,
  isSignUp = false 
}) => {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isPhoneValid, setIsPhoneValid] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validatePhoneNumber = (number: string) => {
    // Simple validation for phone number
    return /^\+?\d{10,15}$/.test(number);
  };

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setPhoneNumber(value);
    setIsPhoneValid(validatePhoneNumber(value));
  };

  const handleGoogleSignIn = (response: any) => {
    if (!isPhoneValid) {
      setError('Please enter a valid phone number first');
      return;
    }
    if (isSignUp && !acceptedTerms) {
      setError('Please read and accept the Terms & Conditions');
      return;
    }
    // Store phone number
    localStorage.setItem('pendingPhoneNumber', phoneNumber);
    onSubmit({ phoneNumber });
    onGoogleSignIn({ ...response, isSignUp, phoneNumber });
  };

  const isFormValid = () => {
    const phoneValid = isPhoneValid;
    const termsAccepted = !isSignUp || acceptedTerms;
    return phoneValid && termsAccepted;
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="mt-2 text-sm text-gray-600">
          {isSignUp ? "Please enter your details to continue" : "Please sign in to continue"}
        </p>
      </div>
      <div className="space-y-4">
        <div>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Phone className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="tel"
              value={phoneNumber}
              onChange={handlePhoneChange}
              className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
              placeholder="+1234567890"
            />
          </div>
        </div>
        {/* Terms and Conditions Checkbox - Only show during sign up */}
        {isSignUp && (
          <div className="flex items-start space-x-3 pt-4">
            <input
              type="checkbox"
              id="acceptTerms"
              checked={acceptedTerms}
              onChange={(e) => setAcceptedTerms(e.target.checked)}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded mt-0.5"
            />
            <div className="flex-1">
              <label htmlFor="acceptTerms" className="block text-sm text-gray-900">
                I have read the {' '}
                <Link 
                  to="/terms" 
                  target="_blank" 
                  className="text-blue-600 hover:text-blue-800 underline font-medium"
                >
                  Terms & Conditions
                </Link>
              </label>
            </div>
          </div>
        )}
        {error && (
          <p className="mt-2 text-sm text-red-600">{error}</p>
        )}
        <div className={`transition-opacity duration-300 ${isFormValid() ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
          <GoogleLogin 
            onSuccess={handleGoogleSignIn}
            onError={onError}
            useOneTap={false}
            type="standard"
            theme="outline"
            text="continue_with"
            shape="rectangular"
            logo_alignment="left"
          />
        </div>
      </div>
    </div>
  );
};

export default PhoneVerification; 

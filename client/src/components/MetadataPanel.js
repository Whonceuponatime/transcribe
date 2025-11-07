import React, { useState, useRef } from 'react';
import './MetadataPanel.css';
import { authenticatedFetch } from '../lib/api';

const MetadataPanel = () => {
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [processingStatus, setProcessingStatus] = useState('');
  const [processedFiles, setProcessedFiles] = useState([]);
  const [metadataOptions, setMetadataOptions] = useState({
    removeAll: true,
    removeLocation: true,
    removeCameraInfo: true,
    removeSoftwareInfo: true,
    removePersonalInfo: true,
    customFields: []
  });
  const [customField, setCustomField] = useState('');
  const fileInputRef = useRef(null);

  const handleFileUpload = (event) => {
    const files = Array.from(event.target.files);
    const validFiles = files.filter(file => {
      const isVideo = file.type.startsWith('video/');
      const isImage = file.type.startsWith('image/');
      return isVideo || isImage;
    });

    if (validFiles.length === 0) {
      alert('Please select valid video or image files.');
      return;
    }

    setUploadedFiles(prev => [...prev, ...validFiles]);
  };

  const removeFile = (index) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const addCustomField = () => {
    if (customField.trim()) {
      setMetadataOptions(prev => ({
        ...prev,
        customFields: [...prev.customFields, customField.trim()]
      }));
      setCustomField('');
    }
  };

  const removeCustomField = (index) => {
    setMetadataOptions(prev => ({
      ...prev,
      customFields: prev.customFields.filter((_, i) => i !== index)
    }));
  };

  const processFiles = async () => {
    if (uploadedFiles.length === 0) {
      alert('Please upload files first.');
      return;
    }

    setIsProcessing(true);
    setProcessingProgress(0);
    setProcessingStatus('Preparing files...');
    setProcessedFiles([]);

    const formData = new FormData();
    
    // Add files
    uploadedFiles.forEach(file => {
      formData.append('files', file);
    });

    // Add metadata options
    formData.append('metadataOptions', JSON.stringify(metadataOptions));

    try {
      const response = await fetch('/api/process-metadata', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error('Failed to process metadata');
      }

      const result = await response.json();
      setProcessedFiles(result.processedFiles || []);
      setProcessingStatus('Processing completed!');
      setProcessingProgress(100);

    } catch (error) {
      console.error('Error processing metadata:', error);
      setProcessingStatus(`Error: ${error.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadFile = (filename) => {
    const link = document.createElement('a');
    link.href = `/api/download-metadata-file/${encodeURIComponent(filename)}`;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadAllFiles = async () => {
    try {
      const response = await fetch('/api/download-all-metadata-files', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ files: processedFiles })
      });

      if (!response.ok) {
        throw new Error('Failed to download files');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'processed-metadata-files.zip';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error downloading files:', error);
      alert('Failed to download files');
    }
  };

  const clearAll = () => {
    setUploadedFiles([]);
    setProcessedFiles([]);
    setProcessingProgress(0);
    setProcessingStatus('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="metadata-panel">
      <div className="metadata-header">
        <h2>🛡️ Metadata Removal & Replacement</h2>
        <p>Upload videos and images to remove or replace metadata for privacy protection</p>
      </div>

      <div className="metadata-container">
        <div className="left-section">
          <div className="upload-section">
            <h3>📁 Upload Files</h3>
            <div className="upload-area">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                multiple
                accept="video/*,image/*"
                className="file-input"
              />
              <div className="upload-placeholder">
                <div className="upload-icon">📤</div>
                <p>Click to select or drag & drop</p>
                <p className="upload-hint">Supports: MP4, AVI, MOV, JPG, PNG, GIF, etc.</p>
              </div>
            </div>
          </div>

          {uploadedFiles.length > 0 && (
            <div className="files-list">
              <h4>Selected Files ({uploadedFiles.length})</h4>
              <div className="files-container">
                {uploadedFiles.map((file, index) => (
                  <div key={index} className="file-item">
                    <div className="file-info">
                      <span className="file-name">{file.name}</span>
                      <span className="file-size">{formatFileSize(file.size)}</span>
                    </div>
                    <button 
                      className="remove-file-btn"
                      onClick={() => removeFile(index)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="right-section">
          <div className="options-section">
            <h3>⚙️ Metadata Options</h3>
            
            <div className="option-group">
              <label className="option-label">
                <input
                  type="checkbox"
                  checked={metadataOptions.removeAll}
                  onChange={(e) => setMetadataOptions(prev => ({
                    ...prev,
                    removeAll: e.target.checked
                  }))}
                />
                Remove All Metadata
              </label>
              <p className="option-description">Remove all metadata from files</p>
            </div>

            <div className="option-group">
              <label className="option-label">
                <input
                  type="checkbox"
                  checked={metadataOptions.removeLocation}
                  onChange={(e) => setMetadataOptions(prev => ({
                    ...prev,
                    removeLocation: e.target.checked
                  }))}
                  disabled={metadataOptions.removeAll}
                />
                Remove Location Data
              </label>
              <p className="option-description">Remove GPS coordinates and location information</p>
            </div>

            <div className="option-group">
              <label className="option-label">
                <input
                  type="checkbox"
                  checked={metadataOptions.removeCameraInfo}
                  onChange={(e) => setMetadataOptions(prev => ({
                    ...prev,
                    removeCameraInfo: e.target.checked
                  }))}
                  disabled={metadataOptions.removeAll}
                />
                Remove Camera Info
              </label>
              <p className="option-description">Remove camera model, settings, and device information</p>
            </div>

            <div className="option-group">
              <label className="option-label">
                <input
                  type="checkbox"
                  checked={metadataOptions.removeSoftwareInfo}
                  onChange={(e) => setMetadataOptions(prev => ({
                    ...prev,
                    removeSoftwareInfo: e.target.checked
                  }))}
                  disabled={metadataOptions.removeAll}
                />
                Remove Software Info
              </label>
              <p className="option-description">Remove software used to create/edit the file</p>
            </div>

            <div className="option-group">
              <label className="option-label">
                <input
                  type="checkbox"
                  checked={metadataOptions.removePersonalInfo}
                  onChange={(e) => setMetadataOptions(prev => ({
                    ...prev,
                    removePersonalInfo: e.target.checked
                  }))}
                  disabled={metadataOptions.removeAll}
                />
                Remove Personal Info
              </label>
              <p className="option-description">Remove author, copyright, and personal information</p>
            </div>

            <div className="custom-fields">
              <h4>Custom Fields to Remove</h4>
              <div className="custom-field-input">
                <input
                  type="text"
                  value={customField}
                  onChange={(e) => setCustomField(e.target.value)}
                  placeholder="Enter field name (e.g., EXIF:Artist)"
                  onKeyPress={(e) => e.key === 'Enter' && addCustomField()}
                />
                <button onClick={addCustomField}>Add</button>
              </div>
              {metadataOptions.customFields.length > 0 && (
                <div className="custom-fields-list">
                  {metadataOptions.customFields.map((field, index) => (
                    <div key={index} className="custom-field-item">
                      <span>{field}</span>
                      <button onClick={() => removeCustomField(index)}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="processing-section">
            <button 
              className="process-btn"
              onClick={processFiles}
              disabled={isProcessing || uploadedFiles.length === 0}
            >
              {isProcessing ? 'Processing...' : '🛡️ Process Metadata'}
            </button>

            {isProcessing && (
              <div className="progress-section">
                <div className="progress-bar">
                  <div 
                    className="progress-fill"
                    style={{ width: `${processingProgress}%` }}
                  ></div>
                </div>
                <p className="progress-text">{processingStatus}</p>
              </div>
            )}

            {processedFiles.length > 0 && (
              <div className="results-section">
                <h4>✅ Processed Files ({processedFiles.length})</h4>
                <div className="processed-files">
                  {processedFiles.map((filename, index) => (
                    <div key={index} className="processed-file-item">
                      <span>{filename}</span>
                      <button 
                        className="download-btn"
                        onClick={() => downloadFile(filename)}
                      >
                        📥 Download
                      </button>
                    </div>
                  ))}
                </div>
                <button 
                  className="download-all-btn"
                  onClick={downloadAllFiles}
                >
                  📦 Download All
                </button>
              </div>
            )}

            <button 
              className="clear-btn"
              onClick={clearAll}
              disabled={isProcessing}
            >
              🗑️ Clear All
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MetadataPanel;

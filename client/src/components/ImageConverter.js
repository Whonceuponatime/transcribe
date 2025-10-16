import React, { useState, useRef } from 'react';
import './ImageConverter.css';

const ImageConverter = () => {
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [isConverting, setIsConverting] = useState(false);
  const [conversionProgress, setConversionProgress] = useState(0);
  const [conversionStatus, setConversionStatus] = useState('');
  const [convertedFiles, setConvertedFiles] = useState([]);
  const [conversionSettings, setConversionSettings] = useState({
    outputFormat: 'png',
    quality: 90,
    resize: false,
    width: 1920,
    height: 1080,
    maintainAspectRatio: true
  });
  const fileInputRef = useRef(null);

  const supportedFormats = [
    { value: 'png', label: 'PNG', description: 'Portable Network Graphics' },
    { value: 'jpg', label: 'JPEG', description: 'Joint Photographic Experts Group' },
    { value: 'jpeg', label: 'JPEG', description: 'Joint Photographic Experts Group' },
    { value: 'webp', label: 'WebP', description: 'Google WebP format' },
    { value: 'gif', label: 'GIF', description: 'Graphics Interchange Format' },
    { value: 'bmp', label: 'BMP', description: 'Bitmap Image' },
    { value: 'tiff', label: 'TIFF', description: 'Tagged Image File Format' },
    { value: 'svg', label: 'SVG', description: 'Scalable Vector Graphics' },
    { value: 'ico', label: 'ICO', description: 'Windows Icon' },
    { value: 'avif', label: 'AVIF', description: 'AV1 Image File Format' }
  ];

  const handleFileUpload = (event) => {
    const files = Array.from(event.target.files);
    const validFiles = files.filter(file => {
      return file.type.startsWith('image/');
    });

    if (validFiles.length === 0) {
      alert('Please select valid image files.');
      return;
    }

    setUploadedFiles(prev => [...prev, ...validFiles]);
  };

  const removeFile = (index) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const convertFiles = async () => {
    if (uploadedFiles.length === 0) {
      alert('Please upload files first.');
      return;
    }

    setIsConverting(true);
    setConversionProgress(0);
    setConversionStatus('Preparing files for conversion...');
    setConvertedFiles([]);

    const formData = new FormData();
    
    // Add files
    uploadedFiles.forEach(file => {
      formData.append('files', file);
    });

    // Add conversion settings
    formData.append('conversionSettings', JSON.stringify(conversionSettings));

    try {
      const response = await fetch('/api/convert-images', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error('Failed to convert images');
      }

      const result = await response.json();
      setConvertedFiles(result.convertedFiles || []);
      setConversionStatus('Conversion completed!');
      setConversionProgress(100);

    } catch (error) {
      console.error('Error converting images:', error);
      setConversionStatus(`Error: ${error.message}`);
    } finally {
      setIsConverting(false);
    }
  };

  const downloadFile = (filename) => {
    const link = document.createElement('a');
    link.href = `/api/download-converted-file/${encodeURIComponent(filename)}`;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadAllFiles = async () => {
    try {
      const response = await fetch('/api/download-all-converted-files', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ files: convertedFiles })
      });

      if (!response.ok) {
        throw new Error('Failed to download files');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'converted-images.zip';
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
    setConvertedFiles([]);
    setConversionProgress(0);
    setConversionStatus('');
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

  const getFileExtension = (filename) => {
    return filename.split('.').pop().toLowerCase();
  };

  return (
    <div className="image-converter">
      <div className="converter-header">
        <h2>🖼️ Image Format Converter</h2>
        <p>Convert images between different formats with quality and resize options</p>
      </div>

      <div className="converter-container">
        <div className="left-section">
          <div className="upload-section">
            <h3>📁 Upload Images</h3>
            <div className="upload-area">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                multiple
                accept="image/*"
                className="file-input"
              />
              <div className="upload-placeholder">
                <div className="upload-icon">📤</div>
                <p>Click to select or drag & drop</p>
                <p className="upload-hint">Supports: PNG, JPG, GIF, WebP, SVG, TIFF, BMP, ICO, AVIF</p>
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
                      <span className="file-format">{getFileExtension(file.name).toUpperCase()}</span>
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
          <div className="settings-section">
            <h3>⚙️ Conversion Settings</h3>
            
            <div className="setting-group">
              <label className="setting-label">
                Output Format
              </label>
              <select
                value={conversionSettings.outputFormat}
                onChange={(e) => setConversionSettings(prev => ({
                  ...prev,
                  outputFormat: e.target.value
                }))}
                className="format-select"
              >
                {supportedFormats.map(format => (
                  <option key={format.value} value={format.value}>
                    {format.label} - {format.description}
                  </option>
                ))}
              </select>
            </div>

            <div className="setting-group">
              <label className="setting-label">
                Quality: {conversionSettings.quality}%
              </label>
              <input
                type="range"
                min="10"
                max="100"
                value={conversionSettings.quality}
                onChange={(e) => setConversionSettings(prev => ({
                  ...prev,
                  quality: parseInt(e.target.value)
                }))}
                className="quality-slider"
              />
              <div className="quality-hint">
                Higher quality = larger file size
              </div>
            </div>

            <div className="setting-group">
              <label className="setting-label">
                <input
                  type="checkbox"
                  checked={conversionSettings.resize}
                  onChange={(e) => setConversionSettings(prev => ({
                    ...prev,
                    resize: e.target.checked
                  }))}
                />
                Resize Images
              </label>
              <p className="setting-description">Resize images to specific dimensions</p>
            </div>

            {conversionSettings.resize && (
              <div className="resize-settings">
                <div className="setting-group">
                  <label className="setting-label">
                    <input
                      type="checkbox"
                      checked={conversionSettings.maintainAspectRatio}
                      onChange={(e) => setConversionSettings(prev => ({
                        ...prev,
                        maintainAspectRatio: e.target.checked
                      }))}
                    />
                    Maintain Aspect Ratio
                  </label>
                </div>

                <div className="dimension-inputs">
                  <div className="dimension-input">
                    <label>Width:</label>
                    <input
                      type="number"
                      value={conversionSettings.width}
                      onChange={(e) => setConversionSettings(prev => ({
                        ...prev,
                        width: parseInt(e.target.value) || 1920
                      }))}
                      min="1"
                      max="8000"
                    />
                  </div>
                  <div className="dimension-input">
                    <label>Height:</label>
                    <input
                      type="number"
                      value={conversionSettings.height}
                      onChange={(e) => setConversionSettings(prev => ({
                        ...prev,
                        height: parseInt(e.target.value) || 1080
                      }))}
                      min="1"
                      max="8000"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="conversion-section">
            <button 
              className="convert-btn"
              onClick={convertFiles}
              disabled={isConverting || uploadedFiles.length === 0}
            >
              {isConverting ? 'Converting...' : '🔄 Convert Images'}
            </button>

            {isConverting && (
              <div className="progress-section">
                <div className="progress-bar">
                  <div 
                    className="progress-fill"
                    style={{ width: `${conversionProgress}%` }}
                  ></div>
                </div>
                <p className="progress-text">{conversionStatus}</p>
              </div>
            )}

            {convertedFiles.length > 0 && (
              <div className="results-section">
                <h4>✅ Converted Files ({convertedFiles.length})</h4>
                <div className="converted-files">
                  {convertedFiles.map((filename, index) => (
                    <div key={index} className="converted-file-item">
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
              disabled={isConverting}
            >
              🗑️ Clear All
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImageConverter;

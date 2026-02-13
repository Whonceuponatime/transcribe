import React, { useState, useRef, useEffect } from 'react';
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
  const [isDragging, setIsDragging] = useState(false);

  // Debug: Log when uploadedFiles changes and verify file input
  useEffect(() => {
    console.log('=== UPLOADED FILES STATE CHANGED ===');
    console.log('Current uploadedFiles count:', uploadedFiles.length);
    if (uploadedFiles.length > 0) {
      console.log('File names:', uploadedFiles.map(f => f.name));
    }
    
    // Verify file input has multiple attribute
    if (fileInputRef.current) {
      const hasMultiple = fileInputRef.current.hasAttribute('multiple');
      console.log('File input multiple attribute:', hasMultiple);
      if (!hasMultiple) {
        console.error('WARNING: File input does not have multiple attribute!');
      }
    }
  }, [uploadedFiles]);

  const supportedFormats = [
    { value: 'png', label: 'PNG', description: 'Portable Network Graphics' },
    { value: 'jpg', label: 'JPEG', description: 'Joint Photographic Experts Group' },
    { value: 'jpeg', label: 'JPEG', description: 'Joint Photographic Experts Group' },
    { value: 'webp', label: 'WebP', description: 'Google WebP format' },
    { value: 'gif', label: 'GIF', description: 'Graphics Interchange Format' },
    { value: 'bmp', label: 'BMP', description: 'Bitmap Image' },
    { value: 'tiff', label: 'TIFF', description: 'Tagged Image File Format' },
    { value: 'ico', label: 'ICO', description: 'Windows Icon' },
    { value: 'avif', label: 'AVIF', description: 'AV1 Image File Format' }
  ];

  const handleFileUpload = (event) => {
    // Force console logs to appear
    console.log('=== FILE UPLOAD EVENT TRIGGERED ===');
    console.log('Event:', event);
    console.log('Event target:', event.target);
    console.log('Event target files:', event.target.files);
    
    const files = Array.from(event.target.files || []);
    console.log('=== FILE UPLOAD EVENT ===');
    console.log('Total files in event:', files.length);
    console.log('File names:', files.map(f => f.name));
    console.log('File input multiple attribute:', fileInputRef.current?.hasAttribute('multiple'));
    
    // Show alert for debugging
    if (files.length > 0) {
      alert(`Files selected: ${files.length}\nFile names: ${files.map(f => f.name).join(', ')}`);
    }
    
    if (files.length > 0) {
      console.log('Processing', files.length, 'files...');
      processFiles(files);
      // Reset the input value AFTER processing so the same files can be selected again if needed
      // Use requestAnimationFrame to ensure state update completes first
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
            console.log('File input reset');
          }
        }, 100);
      });
    } else {
      console.log('No files in event');
      alert('No files selected. Please try selecting files again.');
    }
  };

  const processFiles = (files) => {
    if (!files || files.length === 0) {
      console.log('No files to process');
      return;
    }

    console.log('Processing files:', files.length);
    
    // Log file details for debugging
    files.forEach((file, index) => {
      console.log(`File ${index + 1}:`, {
        name: file.name,
        type: file.type,
        size: file.size,
        extension: file.name.split('.').pop()?.toLowerCase()
      });
    });
    
    const validFiles = files.filter(file => {
      const fileName = file.name.toLowerCase();
      const extension = fileName.split('.').pop() || '';
      
      // Check MIME type first
      const isImage = file.type && file.type.startsWith('image/');
      
      // Check for HEIC/HEIF files (these often don't have proper MIME types)
      // Be very explicit about HEIC detection
      const isHeic = extension === 'heic' || 
                     extension === 'heif' || 
                     fileName.endsWith('.heic') || 
                     fileName.endsWith('.heif') ||
                     fileName.includes('.heic') ||
                     fileName.includes('.heif');
      
      // List of valid image extensions
      const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'ico', 'avif', 'svg', 'heic', 'heif'];
      const hasImageExtension = imageExtensions.includes(extension);
      
      // Accept if it's an image MIME type, has image extension, or is HEIC/HEIF
      // For HEIC, be extra lenient - accept if extension matches OR filename contains heic/heif
      // TEMPORARY: Accept all files with extensions (for debugging)
      const hasAnyExtension = extension && extension.length > 0 && extension.length < 6;
      const isValid = isImage || hasImageExtension || isHeic || hasAnyExtension;
      
      // Always log for debugging
      console.log(`File validation: ${file.name}`, {
        type: file.type || 'NO TYPE',
        extension: extension,
        isImage: isImage,
        isHeic: isHeic,
        hasImageExtension: hasImageExtension,
        isValid: isValid
      });
      
      if (!isValid) {
        console.warn(`File rejected: ${file.name}`, {
          type: file.type || 'NO TYPE',
          extension: extension,
          isImage: isImage,
          isHeic: isHeic,
          hasImageExtension: hasImageExtension
        });
      }
      
      return isValid;
    });

    console.log('Valid files:', validFiles.length, validFiles.map(f => f.name));

    if (validFiles.length === 0) {
      const fileTypes = files.map(f => `${f.name} (${f.type || 'unknown type'})`).join(', ');
      console.error('=== NO VALID FILES FOUND ===');
      console.error('All files were rejected. Files attempted:', files.map(f => ({
        name: f.name,
        type: f.type,
        extension: f.name.split('.').pop()?.toLowerCase()
      })));
      
      // For HEIC files, be more lenient - accept them anyway
      const heicFiles = files.filter(f => {
        const ext = f.name.toLowerCase().split('.').pop();
        return ext === 'heic' || ext === 'heif';
      });
      
      if (heicFiles.length > 0) {
        console.log('HEIC files detected, accepting them anyway:', heicFiles.map(f => f.name));
        // Force accept HEIC files even if validation failed
        setUploadedFiles(prev => {
          const existingFiles = new Set(prev.map(f => `${f.name}-${f.size}`));
          const newFiles = heicFiles.filter(f => !existingFiles.has(`${f.name}-${f.size}`));
          console.log('Force adding HEIC files:', newFiles.length);
          return [...prev, ...newFiles];
        });
        return;
      }
      
      alert(`Please select valid image files.\n\nSelected files:\n${fileTypes}\n\nIf these are image files, they may not have the correct file type detected by your browser.`);
      return;
    }

    // Add all valid files to the list
    setUploadedFiles(prev => {
      // Create a Set to track existing files by name and size to avoid duplicates
      const existingFiles = new Set(prev.map(f => `${f.name}-${f.size}`));
      const newFiles = validFiles.filter(f => !existingFiles.has(`${f.name}-${f.size}`));
      console.log('=== STATE UPDATE ===');
      console.log('Previous files count:', prev.length);
      console.log('New files to add:', newFiles.length);
      console.log('New file names:', newFiles.map(f => f.name));
      console.log('Total will be:', prev.length + newFiles.length);
      const updated = [...prev, ...newFiles];
      console.log('Updated files count:', updated.length);
      return updated;
    });
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) {
      processFiles(files);
    }
  };

  const handleBulkSelectClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const removeFile = (index) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const convertFiles = async () => {
    if (uploadedFiles.length === 0) {
      alert('Please upload files first.');
      return;
    }

    // Warn user if uploading too many files at once
    if (uploadedFiles.length > 100) {
      const proceed = window.confirm(
        `You are about to convert ${uploadedFiles.length} files at once.\n\n` +
        `Large batches may cause connection issues. Consider converting in smaller batches (20-50 files).\n\n` +
        `Do you want to continue?`
      );
      if (!proceed) {
        return;
      }
    }

    console.log('Starting conversion for', uploadedFiles.length, 'files');
    setIsConverting(true);
    setConversionProgress(0);
    setConversionStatus(`Preparing ${uploadedFiles.length} files for conversion...`);
    setConvertedFiles([]);

    const formData = new FormData();
    
    // Add files
    uploadedFiles.forEach((file, index) => {
      formData.append('files', file);
      if (index < 5) {
        console.log(`Added file ${index + 1}:`, file.name);
      }
    });
    
    console.log(`Total files in FormData: ${uploadedFiles.length}`);

    // Add conversion settings
    formData.append('conversionSettings', JSON.stringify(conversionSettings));

    // Progress simulation - update progress bar while waiting
    let progressInterval;
    const startProgress = () => {
      let progress = 5;
      setConversionProgress(progress);
      setConversionStatus(`Uploading ${uploadedFiles.length} files...`);
      
      progressInterval = setInterval(() => {
        progress += Math.random() * 3; // Increment by 0-3% randomly
        if (progress < 90) {
          setConversionProgress(Math.min(progress, 90));
          const estimatedFilesProcessed = Math.floor((progress / 90) * uploadedFiles.length);
          setConversionStatus(`Processing files... (${estimatedFilesProcessed}/${uploadedFiles.length} estimated)`);
        }
      }, 500); // Update every 500ms
    };

    try {
      console.log('Sending request to server with', uploadedFiles.length, 'files');
      
      // Start progress simulation
      startProgress();
      
      // Log FormData contents
      console.log('FormData entries:');
      for (let pair of formData.entries()) {
        if (pair[1] instanceof File) {
          console.log(`  - File: ${pair[1].name}, Type: ${pair[1].type}, Size: ${pair[1].size}`);
        } else {
          console.log(`  - ${pair[0]}: ${pair[1]}`);
        }
      }
      
      setConversionStatus(`Uploading files to server...`);
      setConversionProgress(10);
      
      // Add timeout and better error handling for large uploads
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 minute timeout
      
      let response;
      try {
        response = await fetch('/api/convert-images', {
          method: 'POST',
          body: formData,
          signal: controller.signal,
          // Don't set Content-Type header - let browser set it with boundary for multipart/form-data
        });
      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
          throw new Error('Upload timeout - file upload took too long. Try uploading fewer files at once.');
        }
        if (err.message.includes('ERR_CONNECTION_RESET') || err.message.includes('Failed to fetch')) {
          throw new Error(`Connection reset - the upload may be too large. Try uploading fewer files (recommended: 20-50 files at a time). Error: ${err.message}`);
        }
        throw err;
      }
      
      clearTimeout(timeoutId);

      // Clear progress interval
      if (progressInterval) {
        clearInterval(progressInterval);
      }

      setConversionProgress(95);
      setConversionStatus('Processing conversion on server...');

      console.log('Response status:', response.status);
      console.log('Response ok:', response.ok);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Server error response:', errorText);
        throw new Error(`Failed to convert images: ${errorText}`);
      }

      const result = await response.json();
      setConvertedFiles(result.convertedFiles || []);
      setConversionStatus(`✅ Conversion completed! ${result.convertedCount || result.convertedFiles.length} of ${result.totalFiles || uploadedFiles.length} files converted successfully.`);
      setConversionProgress(100);

    } catch (error) {
      // Clear progress interval on error
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      console.error('Error converting images:', error);
      setConversionStatus(`❌ Error: ${error.message}`);
      setConversionProgress(0);
    } finally {
      // Make sure to clear interval
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      // Don't set isConverting to false immediately - let user see the result
      setTimeout(() => {
        setIsConverting(false);
      }, 2000);
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
        <div className="format-note">
          <p><strong>Note:</strong> SVG conversion is not supported as SVG is a vector format. Use PNG, JPEG, or WebP for best results.</p>
        </div>
      </div>

      <div className="converter-container">
        <div className="left-section">
          <div className="upload-section">
            <h3>📁 Upload Images</h3>
            <div 
              className={`upload-area ${isDragging ? 'dragging' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={(e) => {
                // Always trigger file input when clicking anywhere in upload area
                e.stopPropagation();
                if (fileInputRef.current) {
                  fileInputRef.current.click();
                }
              }}
            >
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                multiple={true}
                accept="image/*,.heic,.heif"
                className="file-input"
                style={{ display: 'none' }}
                id="image-file-input"
              />
              <div className="upload-placeholder">
                <div className="upload-icon">📤</div>
                <p>{isDragging ? 'Drop files here' : 'Click to select or drag & drop multiple files'}</p>
                <p className="upload-hint">Supports: PNG, JPG, GIF, WebP, TIFF, BMP, ICO, AVIF, HEIC</p>
                <p className="upload-hint" style={{ marginTop: '10px', fontWeight: 'bold', color: '#00ff00' }}>
                  💡 How to select multiple files: Hold Ctrl (Windows) or Cmd (Mac) and click files, or drag & drop multiple files
                </p>
                {uploadedFiles.length > 0 && (
                  <p className="upload-hint" style={{ marginTop: '10px', fontWeight: 'bold', color: '#00ff00' }}>
                    ✅ {uploadedFiles.length} file{uploadedFiles.length !== 1 ? 's' : ''} ready to convert
                  </p>
                )}
              </div>
            </div>
            <button 
              className="bulk-select-btn"
              onClick={handleBulkSelectClick}
              style={{ marginTop: '15px', width: '100%' }}
            >
              📂 Select Multiple Files
            </button>
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


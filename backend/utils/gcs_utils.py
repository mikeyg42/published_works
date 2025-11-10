from google.cloud import storage
import logging
import os
import io

def upload_bytes_to_gcs(bucket_name: str, blob_name: str, data: bytes, 
                      content_type: str = 'image/png', 
                      local_fallback: bool = True) -> str:
    """
    Upload bytes to Google Cloud Storage and return the public URL.
    In local development, can fall back to saving files locally.
    
    Args:
        bucket_name: Name of the GCS bucket
        blob_name: Path and name of the blob in the bucket
        data: Bytes to upload
        content_type: MIME type of the content
        local_fallback: If True, save locally when GCS upload fails
        
    Returns:
        Public URL of the uploaded file or local path
    """
    try:
        # Try Google Cloud Storage first
        client = storage.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_name)
        
        # Upload the bytes
        blob.upload_from_string(data, content_type=content_type)
        
        # Make the blob publicly readable
        blob.make_public()
        
        # Return the public URL
        return f"https://storage.googleapis.com/{bucket_name}/{blob_name}"
    except Exception as e:
        logging.error(f"Failed to upload to GCS: {str(e)}")
        
        # Local fallback for development testing
        if local_fallback:
            try:
                # Create directory structure if it doesn't exist
                local_dir = os.path.join("visualizations", os.path.dirname(blob_name))
                os.makedirs(local_dir, exist_ok=True)
                
                # Save the file locally
                local_path = os.path.join("visualizations", blob_name)
                with open(local_path, "wb") as f:
                    f.write(data)
                
                logging.info(f"Saved visualization locally at: {local_path}")
                return f"file://{os.path.abspath(local_path)}"
            except Exception as local_err:
                logging.error(f"Failed to save locally: {str(local_err)}")
        
        # Re-raise the original exception if local fallback fails or is disabled
        raise 
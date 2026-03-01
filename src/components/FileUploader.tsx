import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, File } from 'lucide-react';

interface FileUploaderProps {
    onFilesSelected: (files: File[]) => void;
    multiple?: boolean;
    accept?: Record<string, string[]>;
    description?: string;
}

export const FileUploader = ({
    onFilesSelected,
    multiple = true,
    accept = { 'application/pdf': ['.pdf'] },
    description = "or drop PDFs here"
}: FileUploaderProps) => {
    const onDrop = useCallback((acceptedFiles: File[]) => {
        if (acceptedFiles?.length > 0) {
            onFilesSelected(acceptedFiles);
        }
    }, [onFilesSelected]);

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop,
        accept,
        multiple
    });

    return (
        <div
            {...getRootProps()}
            className={`
        border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all duration-300
        flex flex-col items-center justify-center gap-4 min-h-[300px]
        ${isDragActive
                    ? 'border-red-500 bg-red-50 scale-[1.02]'
                    : 'border-gray-300 hover:border-red-400 hover:bg-gray-50'
                }
      `}
        >
            <input {...getInputProps()} />
            <div className={`p-6 rounded-full ${isDragActive ? 'bg-red-100' : 'bg-red-50'} transition-colors`}>
                {isDragActive ? (
                    <File className="w-12 h-12 text-red-600 animate-bounce" />
                ) : (
                    <Upload className="w-12 h-12 text-red-600" />
                )}
            </div>
            <div className="space-y-2">
                <h3 className="text-2xl font-bold text-gray-700">
                    {isDragActive ? 'Drop files here' : 'Select PDF files'}
                </h3>
                <p className="text-gray-500">{description}</p>
            </div>
            <button className="btn text-lg px-8 py-4 mt-4 shadow-lg hover:shadow-xl transform hover:-translate-y-1">
                Select PDF files
            </button>
        </div>
    );
};

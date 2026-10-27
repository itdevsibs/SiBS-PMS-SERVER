import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
// Private directory is deliberately outside the public /uploads static path.
const root=path.resolve(process.env.FRONTSTEPS_IMPORT_DIR||path.join(process.cwd(),'private_uploads','frontsteps'));
fs.mkdirSync(root,{recursive:true});
const maxFileSize=Number(process.env.FRONTSTEPS_IMPORT_MAX_MB||25)*1024*1024;
const upload=multer({
  storage:multer.diskStorage({
    destination(_req,_file,cb) {cb(null,root);},
    filename(_req,file,cb) {
      const name=path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g,'_');
      cb(null,`${Date.now()}-${crypto.randomUUID()}-${name}`);
    },
  }),
  limits:{fileSize:maxFileSize,files:1},
  fileFilter(_req,file,cb) {
    if (!['.csv','.xlsx','.xls'].includes(path.extname(file.originalname).toLowerCase())) {
      return cb(Object.assign(new Error('Upload a CSV, XLSX, or XLS file'),{status:400,code:'INVALID_FILE_TYPE'}));
    }
    cb(null,true);
  },
});
export function frontStepsUploadMiddleware(req,res,next) {
  upload.single('file')(req,res,error=>{
    if (!error) return next();
    const tooLarge=error.code==='LIMIT_FILE_SIZE';
    res.status(tooLarge?413:error.status||400).json({success:false,code:tooLarge?'FILE_TOO_LARGE':error.code||'UPLOAD_FAILED',message:tooLarge?'Upload exceeds FrontSteps file limit':error.message});
  });
}

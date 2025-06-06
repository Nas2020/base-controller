import { Injectable } from "@nestjs/common";
import { SisLoaderService } from "./sisLoader.service";
import { RedisService } from "../../services/redis.service";
import { CourseDto, HighSchoolCourseDto, HighSchoolTermDto, HighSchoolTranscriptDto, TermDto, TranscriptDto } from "../../dtos/transcript.dto";
import { StudentIdDto } from "../../dtos/studentId.dto";
import { CsvLoaderService } from "./csvLoader.service";
import { PdfLoaderService } from "./pdfLoader.service";
import * as path from "path";
import * as Pdf from 'pdf-parse';
import * as fs from "fs";
import * as Zip from 'adm-zip';
process.env.PDF2JSON_DISABLE_LOGS = '1';
const PDFParser = require('pdf2json');
import { PDFDocument } from 'pdf-lib';


const headings = [
    "STUDENT INFORMATION",
    "SCHOOL INFORMATION",
    "CREDIT HISTORY",
    "UNIVERSITY OF NORTH CAROLINA BOARD OF GOVERNORS MINIMUM COURSE REQUIREMENTS REMAINING",
    "PERFORMANCE INFORMATION",
    "TESTING INFORMATION",
    "* ENDORSEMENT DETAILS",
    "CURRICULUM RELATED WORK EXPERIENCE",
    "AWARD/ACHIEVEMENTS AND EXTRA-CURRICULAR ACTIVITIES",
    "GRADING AND GPA DETAILS"
]

@Injectable()
export class NhcsLoaderService extends SisLoaderService {

    private readonly uploadDir = './uploads' // The docker volume where uploads should go
    
    constructor(
        private readonly redisService: RedisService,
        private readonly csvLoaderService: CsvLoaderService,
        private readonly pdfLoaderService: PdfLoaderService,
    ) {
        super();
    };
    
    async load(): Promise<void> {
        await this.csvLoaderService.load();

        const files = fs.readdirSync(this.uploadDir);
        const zipFile = files.find((file) => file.endsWith('.zip'));

        if (!zipFile) {
            console.error('No zip file found in the uploads directory');
            return;
        }
        console.log("Loading SIS data from zip file using PDFLoader: ", zipFile)
    
        const zipPath = path.join(this.uploadDir, zipFile);

        let zip = new Zip(zipPath);
        let zipEntries = zip.getEntries();

        let successes = 0;
        let failures = 0;
        for (const zipEntry of zipEntries) {
            if (!zipEntry.entryName.endsWith('.pdf')) {
                continue;
            }
    
            console.log(`Loading PDF: ${zipEntry.entryName}`);
    
            const pdfBuffer = await zipEntry.getData();
    
            let transcriptBuffers: Buffer[];
    
            try {
                transcriptBuffers = await this.splitPdfByTranscripts(pdfBuffer);
                console.log(`Found ${transcriptBuffers.length} transcript(s) in ${zipEntry.entryName}`);
            } catch (err) {
                console.error("Error splitting PDF into transcripts:", zipEntry.entryName);
                console.error(err);
                continue;
            }
    
            for (const singleTranscriptBuffer of transcriptBuffers) {
                try {
                    const transcript = await this.parsePdfNhcs(singleTranscriptBuffer);
                    
                    if (!transcript.studentNumber) {
                        throw new Error(`StudentID could not be parsed from transcript index: ${transcriptBuffers.indexOf(singleTranscriptBuffer)}`);
                    }
                    
                    this.redisService.set(`${transcript.studentNumber}:transcript`, JSON.stringify(transcript));
                    console.log(`Saved ${transcript.studentNumber}:transcript`);
    
                    successes++;
                } catch (err) {
                    console.error("Error parsing/saving transcript from PDF: ", err);
                    failures++;
                    continue;
                }
            }
        }
    
        console.log(`Finished loading: ${successes} success(es), ${failures} failure(s)`);
    }

    async getStudentId(studentNumber: string): Promise<StudentIdDto> {
        const studentId: StudentIdDto = JSON.parse(await this.redisService.get(`${studentNumber}:studentId`));
        return studentId;
    }

    async getStudentTranscript(studentNumber: string): Promise<HighSchoolTranscriptDto> {
        const transcript: HighSchoolTranscriptDto = JSON.parse(await this.redisService.get(`${studentNumber}:transcript`));
        return transcript;
    }

    async splitPdfByTranscripts(pdfBuffer: Buffer): Promise<Buffer[]> {
        const originalPdf = await PDFDocument.load(pdfBuffer);
        const totalPages = originalPdf.getPageCount();

        const transcriptStarts: number[] = [];

        for (let i = 0; i < totalPages; i++) {
            const newPdf = await PDFDocument.create();
            const [copiedPage] = await newPdf.copyPages(originalPdf, [i]);
            newPdf.addPage(copiedPage);
            const pageBytes = await newPdf.save();

            const textData = await Pdf(Buffer.from(pageBytes));
            if (textData.text.includes('Official NC Transcript')) {
                transcriptStarts.push(i);
            }
        }

        const transcriptBuffers: Buffer[] = [];

        for (let i = 0; i < transcriptStarts.length; i++) {
            const start = transcriptStarts[i];
            const end = transcriptStarts[i + 1] ?? totalPages;

            const newPdf = await PDFDocument.create();
            const pageIndices = Array.from({ length: end - start }, (_, idx) => start + idx);
            const copiedPages = await newPdf.copyPages(originalPdf, pageIndices);
            copiedPages.forEach(p => newPdf.addPage(p));

            const newPdfBytes = await newPdf.save();
            transcriptBuffers.push(Buffer.from(newPdfBytes));
        }

        return transcriptBuffers;
    }

    async parsePdfNhcs(pdfBuffer: Buffer): Promise<HighSchoolTranscriptDto> {
        let transcript = new HighSchoolTranscriptDto();

        let pdfParser = await Pdf(pdfBuffer);
        const pdfText = pdfParser.text.split("\n")
            .map(str => str.trim())
            .filter(str => str);

        let courseText: string[] = this.filterCourseText(pdfText);
        const courseBlocks: string[][] = this.splitCourses(courseText);
        const courses: HighSchoolCourseDto[] = courseBlocks.map(block => this.parseCourse(block));

        transcript.terms = this.parseTerms(pdfText);

        // Assign courses to terms based on y-axis positions in the document
        const positionalData = await this.parsePositionalData(pdfBuffer);
        courses.forEach(course => {
            const courseTerm = this.sortCourse(course, transcript.terms, positionalData);
            if (courseTerm !== null) {
                (courseTerm.courses as CourseDto[]).push(course);
            }
        });

        transcript.transcriptDate = pdfText.filter(str => /^\d{2}\/\d{2}\/\d{4}$/.test(str))[0] ?? null;

        transcript.transcriptComments = this.filterTextByHeading(pdfText, 9).join("\n");
        transcript.studentNumber = this.pdfLoaderService.stringAfterField(pdfText, "Student No");

        // JSON.parse(await this.redisService.get(`${transcript.studentNumber}:studentId`)); // TODO Reference data from CSV for consistency

        transcript.studentFullName = this.pdfLoaderService.stringAfterField(pdfText, "Student Name");
        transcript.studentBirthDate = this.pdfLoaderService.stringAfterField(pdfText, "Birthdate");
        transcript.studentAddress = this.pdfLoaderService.stringAfterField(pdfText, "Address"); // TODO Parse rest of address
        transcript.studentSex = this.pdfLoaderService.stringAfterField(pdfText, "Sex");
        transcript.studentContacts = this.pdfLoaderService.stringAfterField(pdfText, "Contacts");
        transcript.graduationDate = this.pdfLoaderService.stringAfterField(pdfText, "Graduation Date");
        transcript.program = this.pdfLoaderService.stringAfterField(pdfText, "Course Of Study");

        const officialTranscriptIndex = pdfText.indexOf("Official NC Transcript");
        transcript.schoolName = pdfText[officialTranscriptIndex - 4] ?? null;
        transcript.schoolPhone = pdfText[officialTranscriptIndex - 1] ?? null;
        transcript.schoolAddress = pdfText.slice(officialTranscriptIndex - 3, officialTranscriptIndex - 1).join("\n") ?? null;
        transcript.schoolCode = this.pdfLoaderService.stringAfterField(pdfText, "School No");
        transcript.gpa = this.pdfLoaderService.stringAfterField(pdfText, "Cumulative GPA Weighted");
        transcript.earnedCredits = this.pdfLoaderService.stringAfterField(pdfText, "Total Credits Toward Graduation");

        transcript.gpaUnweighted = this.pdfLoaderService.stringAfterField(pdfText, "Cumulative GPA Unweighted");
        transcript.totalPoints = this.pdfLoaderService.stringAfterField(pdfText, "Total Points Weighted").replace(/\s+/g, '');
        transcript.totalPointsUnweighted = this.pdfLoaderService.stringAfterField(pdfText, "Total Points Unweighted").replace(/\s+/g, '');
        transcript.classRank = this.pdfLoaderService.stringAfterField(pdfText, "Class Rank").match(/\d+ out of \d+/)[0] ?? null;

        transcript.schoolDistrict = this.pdfLoaderService.stringAfterField(pdfText, "L.E.A.");
        transcript.schoolDistrictPhone = pdfText[pdfText.indexOf(pdfText.find(str => str.startsWith("L.E.A."))) + 1] ?? null;
        transcript.schoolAccreditation = this.pdfLoaderService.stringAfterField(pdfText, "Accreditation");
        transcript.schoolCeebCode = this.pdfLoaderService.stringAfterField(pdfText, "College Board Code");
        transcript.schoolPrincipal = this.pdfLoaderService.stringAfterField(pdfText, "Principal");
        transcript.schoolPrincipalPhone = pdfText[pdfText.indexOf(pdfText.find(str => str.startsWith("Principal"))) + 1] ?? null;

        transcript.endorsements = this.filterTextByHeading(pdfText, 6).join("\n");
        transcript.mathRigor = this.pdfLoaderService.stringAfterField(pdfText, "Math Rigor");
        transcript.reqirementsRemaining = this.filterTextByHeading(pdfText, 3).join("\n");
        transcript.workExperience = this.filterTextByHeading(pdfText, 7).join("\n");
        transcript.achievements = this.filterTextByHeading(pdfText, 8).slice(0, -2).join("\n");
        transcript.tests = this.filterTextByHeading(pdfText, 5).join("\n");

        transcript.ctePrograms = pdfText.find(str => str.startsWith("CTE Concentrator**")).split(/:/)[1];

        return transcript;
    }

    parseTerms(pdfText: string[]): HighSchoolTermDto[] {
        let terms = [];
        let termIndex = 0;
        while (true) {
            let term = new HighSchoolTermDto();
            const termInfo = this.pdfLoaderService.stringAfterField(pdfText, "Grade", termIndex);
            if (termInfo) {
                term.termYear = termInfo.slice(-7);
                term.termGradeLevel = termInfo.replace(term.termYear, "");
                term.courses = [];
                terms.push(term);
            }
            else {
                break;
            }
            termIndex++;
        }
        return terms;
    }

    async parsePositionalData(pdfBuffer: Buffer): Promise<any> {
        const parser = new PDFParser();

        if (parser?.pdf2json?.p2jwarn) {
            parser.pdf2json.p2jwarn = () => {};
        }

        return new Promise((resolve) => {
            parser.on("pdfParser_dataReady", (pdfData) => {
                const allItems = [];

                const pages = pdfData?.Pages || [];

                pages.forEach((page, pageIndex) => {
                    const pageText = page.Texts;

                    pageText.forEach(textObj => {
                        const text = decodeURIComponent(textObj.R[0].T);
                        allItems.push({
                            text,
                            x: textObj.x,
                            y: textObj.y,
                            page: pageIndex + 1,
                        });
                    });
                });

                resolve(allItems);
            });

            parser.parseBuffer(pdfBuffer);
        });
    }

    sortCourse(course: CourseDto, terms: any, positionalData: any): HighSchoolTermDto {
        const termPositions = positionalData.filter(item => item["text"].startsWith("Grade:"));

        for (let i = 0; i < positionalData.length - 2; i++) {
            const courseCodeEnd: boolean = course.courseCode.endsWith(positionalData[i]["text"]);
            const courseTitleStart: boolean = course.courseTitle.startsWith(positionalData[i+2]["text"]);

            if (courseCodeEnd && courseTitleStart) {
                const courseY = positionalData[i]["y"];
                const coursePage = positionalData[i]["page"];

                let termIndex = -1;
                for (let j = 0; j < termPositions.length; j++) {
                    if (
                        coursePage > termPositions[j]["page"] 
                        || (coursePage === termPositions[j]["page"] && courseY > termPositions[j]["y"])
                    ) {
                        termIndex = j;
                    }
                }

                if (termIndex >= 0) return terms[termIndex];
            }
        }
        return null;
    }

    filterTextByHeading(lines: string[], headingIndex: number): string[] {
        let filteredLines = [];
        const startKey = headings[headingIndex];
        const endKey = headings[headingIndex + 1] ?? null;
        const breakRegex = /^[A-Za-z]+ \d+, \d+$/; // Matches a date like: April 15, 2025
        let inHeading = false;
        let inPageBreak = false;
        let pageBreakCouter = 0;
        for (const line of lines) {
            if (endKey && endKey.includes(line)) {
                break;
            }

            if (inHeading) {
                if (breakRegex.test(line)) {
                    inPageBreak = true;
                    pageBreakCouter = 1;
                    continue;
                }
                else if (inPageBreak) {
                    pageBreakCouter++;
                    if (pageBreakCouter >= 5) inPageBreak = false;
                    continue;
                }

                if (!startKey.includes(line)) {
                    filteredLines.push(line);
                }
            }

            if (startKey.includes(line)) {
                inHeading = true;
            }
        }
        return filteredLines;
    }

    filterCourseText(lines: string[]): string[] {
        let courseLines: string[] = [];
        const startKey = "Flags";
        const breakRegex = /[A-Za-z]+ \d+, \d+/; // Matches a date like: April 15, 2025
        const endKey = "UNIVERSITY OF NORTH CAROLINA BOARD OF GOVERNORS"
        let inCourses = false;
        for (const line of lines) {
            if (line === endKey) {
                break;
            }
            else if (breakRegex.test(line)) {
                inCourses = false;
            }
            else if (inCourses) {
                courseLines.push(line);
            }

            if (line === startKey) {
                inCourses = true;
            }
        }
        return courseLines;
    }

    splitCourses(lines: string[]): string[][] {
        const courses: string[][] = [];
        let currentCourse: string[] = [];
    
        // Regex to match course codes like "10225X0", "1 1412Y0", "5C015X0" followed by the course title
        const courseStartRegex = /^([A-Z0-9]\s*){7}\s+.+/;
    
        for (const line of lines) {
            const courseStart: boolean = courseStartRegex.test(line);
            if (courseStart && currentCourse.length > 0) {
                courses.push(currentCourse);
                currentCourse = [];
            }
            currentCourse.push(line);
        }
    
        if (currentCourse.length > 0) {
            courses.push(currentCourse);
        }
    
        return courses;
    }

    parseCourse(courseBlock: string[]): HighSchoolCourseDto {
        let course = new HighSchoolCourseDto();
        let workingString = courseBlock.join(' ').replace(/\s+/g, ' ').trim();

        // Match the course code: 7 characters (including letters, digits), skipping leading number if present
        const courseCodeMatch = workingString.match(/^(([A-Z0-9]\s*){7})\s+.+/);
        course.courseCode = courseCodeMatch ? courseCodeMatch[1].replace(/\s/, "") : null;

        // Remove course code from remaining parse
        if (courseCodeMatch) workingString = workingString.replace(courseCodeMatch[1], "").trim();

        // Extract credit/grade at the end of the string (numbers, decimals, and optional flags)
        const creditLine = this.extractCreditValues(course, workingString);

        // Remove credit line from remaining parse, and we should only have the title
        course.courseTitle = workingString.replace(creditLine, '').trim();

        return course;
    }

    extractCreditValues(course: HighSchoolCourseDto, courseString: string): string {
        const tokens: string[] = courseString.trim().split(/\s+/);
        let creditTokens: string[] = [];
        let hasFlags: boolean = false;

        // Work backwards from the end of the string searching for numeric values: 96, 1.000
        // The last token in the string can also be flags: EU, U
        for (let i = tokens.length - 1; i >= 0; i--) {
            if (i === tokens.length - 1 && /[A-Z]+/.test(tokens[i])) {
                creditTokens.unshift(tokens[i]);
                course.flags = tokens[i].split("");
                hasFlags = true;
            }
            else if (/[\d\.]/.test(tokens[i])) {
                creditTokens.unshift(tokens[i]);
            }
            else {
                break;
            }
        }

        // Some courses end in a number "NC Math 1"
        // GPA courses have 4 fields and optional flags
        // Non-GPA courses have 2 fields and optional flags
        // Therefore: flagged courses are either 3 or 5 values and non-flagged courses are either 2 or 4 values
        // So we need to remove the first element if we have too many
        if (hasFlags) {
            if (creditTokens.length === 4 || creditTokens.length === 6) creditTokens.shift();
            
            if (creditTokens.length === 3) {
                course.grade = creditTokens[0];
                course.creditEarned = creditTokens[1];
                course.flags = creditTokens[2].split("");
            }
            else if (creditTokens.length === 5) {
                course.grade = creditTokens[0];
                course.gradePoints = creditTokens[1];
                course.gradePointsUnweighted = creditTokens[2];
                course.creditEarned = creditTokens[3];
                course.flags = creditTokens[4].split("");
            }
        }
        else {
            if (creditTokens.length === 3 || creditTokens.length === 5) creditTokens.shift();

            if (creditTokens.length === 2) {
                course.grade = creditTokens[0];
                course.creditEarned = creditTokens[1];
            }
            else if (creditTokens.length === 4) {
                course.grade = creditTokens[0];
                course.gradePoints = creditTokens[1];
                course.gradePointsUnweighted = creditTokens[2];
                course.creditEarned = creditTokens[3];
            }
        }

        // Return the raw course string so that we can remove it from the workingString
        return courseString.slice(courseString.indexOf(creditTokens[0]));
    }
}

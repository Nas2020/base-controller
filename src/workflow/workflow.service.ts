import { Injectable, OnModuleInit } from "@nestjs/common";
import { WorkflowsService } from "./workflows/workflows.service";
import * as defaultWorkflow from './default_workflow.json'
import { Workflows } from "./workflows/workflows.entity";
import { WorkflowParser, DefaultWorkflow, DefaultAction, DefaultDisplay, Workflow, Instance } from '@veridid/workflow-parser';
import { ConfigService } from "@nestjs/config";
import { ExtendedAction } from './extensions/action.extension';
import { ExtendedDisplay } from './extensions/display.extension';
import { AcaPyService } from '../services/acapy.service';


@Injectable()
export class WorkflowService implements OnModuleInit {

    public controllerClient: any;
    defaultWorkflow: DefaultWorkflow;
    defaultAction: DefaultAction;
    displayExtension: ExtendedDisplay;
    defaultDisplay: DefaultDisplay;
    parser: WorkflowParser;

    constructor(
        private readonly configService: ConfigService,
        private readonly acapyService: AcaPyService,
        private readonly actionExtension: ExtendedAction,
        private readonly workflowsService: WorkflowsService,
    ) {
        this.controllerClient = {
            user: this.configService.get<string>('WORKFLOW_DB_USER', 'postgres'),
            password: this.configService.get<string>('WORKFLOW_DB_PASSWORD', 'password123'),
            host: this.configService.get<string>('WORKFLOW_DB_HOST', 'localhost'),
            port: this.configService.get<number>('WORKFLOW_DB_PORT', 5435),
            database: this.configService.get<string>('WORKFLOW_DB_NAME', 'postgres'),
        }
        this.defaultWorkflow = new DefaultWorkflow(this.controllerClient);
        this.defaultAction = new DefaultAction(this.actionExtension);
        this.displayExtension = new ExtendedDisplay();
        this.defaultDisplay = new DefaultDisplay(this.displayExtension);
        this.parser = new WorkflowParser(this.defaultDisplay, this.defaultAction, this.defaultWorkflow);
    }

    


    async getWorkflowById(workflowID: string ): Promise<Workflow> {
        return this.defaultWorkflow.getWorkflowByID(workflowID);
    }

    async updateInstanceByID(clientID: string, workflowID: string, stateID: string, data: any): Promise<Instance> {
        return this.defaultWorkflow.updateInstanceByID(clientID, workflowID, stateID, data);
    }

    async getInstanceByID(clientID: string, workflowID: string): Promise<Instance> {
        return this.defaultWorkflow.getInstanceByID(clientID, workflowID);
    }

    async getInstanceByData(clientID: string, data: any): Promise<Instance> {
        //return this.defaultWorkflow.getInstanceByData(clientID, data);
        //**** need to implement get by data in workflow-parser defaultWorkflow
        return this.defaultWorkflow.getInstanceByID(clientID, "root-menu");
    }

    async initiateDefaultWorkflow(connectionID: any) {
        const defaultWorkflowAction = {
            workflowID: "root-menu",
            actionID: "",
            data: {}
        }
        console.log("Parse the default workflow");
        const displayData = await this.parser.parse(connectionID, defaultWorkflowAction);
        console.log("About to send=", displayData);
        this.sendWorkflow(connectionID, displayData);
    }

    async forceDefaultWorkflow(connectionID: any) {
        const defaultWorkflowAction = {
            workflowID: "root-menu",
            actionID: "",
            data: {}
        }
        // **** Needs to force the instance to initial state
        let instance = await this.defaultWorkflow.getInstanceByID(connectionID, defaultWorkflowAction.workflowID)
        const workflow = await this.defaultWorkflow.getWorkflowByID("root-menu");
        const initial_state = workflow.initial_state;
        instance.current_state = initial_state;
        await this.defaultWorkflow.updateInstanceByID(connectionID, defaultWorkflowAction.workflowID, initial_state, defaultWorkflowAction);
        const displayData = await this.parser.parse(connectionID, defaultWorkflowAction);

        this.sendWorkflow(connectionID, displayData);
    }

    async sendWorkflow(connectionID: string, displayData: any) {
        await this.acapyService.sendMessage(connectionID,JSON.stringify(displayData));
    }

    async onModuleInit() {
        console.log("Loading workflows");
        try {
            // If there are no workflows, load in the default one
            console.log("About to getWorkflows");
            const workflows = await this.workflowsService.getWorkflows();
            console.log("After getWorkflows");
            if(workflows.length==0) {
                console.log("Empty workflows");
                const workflow = new Workflows();
                workflow.workflow_id = defaultWorkflow.workflow_id;
                workflow.name = defaultWorkflow.name;
                workflow.initial_state = defaultWorkflow.initial_state;
                workflow.render = null;
                workflow.states = defaultWorkflow.states as any;
                console.log("Save the demo workflow");
                this.workflowsService.save([workflow]);
            }
        } catch (error) {
            console.error('Error initializing workflows:', error.message);
        }
    }
}